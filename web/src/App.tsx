import {
  startTransition,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import type { Session } from '@supabase/supabase-js'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'
import {
  DEFAULT_INCOME_TAX_BRACKET_ID,
  incomeTaxBrackets,
} from './data/incomeTaxBrackets'
import { usStates } from './data/usStates'
import { formatCurrency, formatCurrencyCompact, formatPercent } from './lib/formatters'
import {
  resolveCashFlowAmount,
  calculateAnnualMortgage,
  deriveHousingItems,
  simulateScenario,
} from './lib/simulate'
import type { CashFlowItem, HousingPlan, Scenario, ScenarioWorkspace } from './types'
import { FormattedNumberInput } from './components/FormattedNumberInput'
import { AuthPanel } from './components/AuthPanel'
import { isSupabaseConfigured, supabase } from './lib/supabase'
import { fetchAverageTaxRate } from './lib/taxRate'

const cloneScenario = (scenario: Scenario) => structuredClone(scenario)
const SCENARIOS_STORAGE_KEY = 'fire-calculator-scenarios-v1'
const LEGACY_SAVED_SCENARIOS_STORAGE_KEY = 'fire-calculator-saved-scenarios-v1'
const LEGACY_SAVED_SCENARIOS_STORAGE_KEY_V2 = 'fire-calculator-saved-scenarios-v2'
const DRAFT_SCENARIO_STORAGE_KEY = 'fire-calculator-draft-scenario-v1'
const WORKSPACE_TABLE = 'user_workspaces'
const LEGACY_PRESET_SOURCE_SHEETS = new Set([
  'House-public school',
  'Rent + private school',
  'House + private school',
  'Rent + public school',
])
const LEGACY_PRESET_NAMES = new Set([
  'house + public school',
  'rent + private school',
  'house + private school',
  'rent + public school',
  'rent & private school',
  'rent & public school',
  'house & private school',
  'house & public school',
])
const LEGACY_PRESET_SUMMARIES = new Set([
  'Buy a $2.5M home in 2030, absorb a tech-bubble haircut now, then sell half the appreciated value in 2050.',
  'Stay flexible on housing, pay for private school later, and keep the target open-ended until a goal is chosen.',
])

type EditorColumnKey =
  | 'drag'
  | 'type'
  | 'label'
  | 'pretax'
  | 'amount'
  | 'start'
  | 'end'
  | 'action'

const DEFAULT_EDITOR_COLUMN_WIDTHS: Record<EditorColumnKey, number> = {
  drag: 52,
  type: 232,
  label: 320,
  pretax: 220,
  amount: 220,
  start: 110,
  end: 110,
  action: 128,
}

const MIN_EDITOR_COLUMN_WIDTHS: Record<EditorColumnKey, number> = {
  drag: 44,
  type: 220,
  label: 180,
  pretax: 160,
  amount: 160,
  start: 88,
  end: 88,
  action: 112,
}

const createDefaultHousingPlan = (): HousingPlan => ({
  enabled: false,
  homePrice: null,
  hoaAnnualCost: null,
  purchaseYear: 2030,
  annualInterestRate: 0.06,
  mortgageTermYears: 30,
  mortgageEndYear: 2060,
  downPaymentRate: 0.2,
  closingCostRate: 0.04,
  propertyTaxRate: 0.02,
  propertyTaxEndYear: 2100,
  saleYear: null,
  saleAppreciationRate: 0,
  saleOwnershipShare: 1,
})

const blankScenario: Scenario = {
  id: 'blank-scenario',
  name: '',
  summary: '',
  sourceSheet: '',
  startingSnapshotLabel: 'Enter your starting net worth',
  currentNetWorth: null,
  householdIncome: null,
  workState: 'California',
  incomeTaxRate: null,
  startYear: 2026,
  endYear: 2060,
  investmentReturnRate: 0.04,
  incomeTaxBracketId: DEFAULT_INCOME_TAX_BRACKET_ID,
  houseOwnershipPlan: 'no',
  goalNetWorth: null,
  housing: createDefaultHousingPlan(),
  additionalHomes: [],
  cashFlowItems: [],
}

const createScenarioId = () => `scenario-${crypto.randomUUID()}`

const createBlankScenario = (name = '') =>
  cloneScenario({
    ...blankScenario,
    id: createScenarioId(),
    name,
  })

const isHousingPlanComplete = (housing: HousingPlan, scenario: Scenario) => {
  if (!housing.enabled) {
    return true
  }

  if (housing.homePrice === null || housing.homePrice <= 0) {
    return false
  }

  if (housing.purchaseYear < scenario.startYear || housing.purchaseYear > scenario.endYear) {
    return false
  }

  if (housing.saleYear !== null && housing.saleYear < housing.purchaseYear) {
    return false
  }

  return true
}

const isCashFlowItemComplete = (item: CashFlowItem) => {
  if (item.kind === null || item.label.trim() === '' || item.startYear > item.endYear) {
    return false
  }

  if (item.kind === 'income') {
    return item.preTaxAmount !== null || item.amount !== null
  }

  return item.amount !== null
}

const getScenarioLabel = (scenario: Scenario, index: number) =>
  scenario.name.trim() || `Untitled scenario ${index + 1}`

const ensureDefaultScenarioName = (workspace: ScenarioWorkspace): ScenarioWorkspace => {
  if (
    workspace.scenarios.length === 1 &&
    workspace.scenarios[0].name.trim() === ''
  ) {
    return {
      ...workspace,
      scenarios: workspace.scenarios.map((scenario, index) =>
        index === 0
          ? {
              ...scenario,
              name: 'Scenario 1',
            }
          : scenario,
      ),
    }
  }

  return workspace
}

const ensureDefaultWorkspace = (workspace: ScenarioWorkspace): ScenarioWorkspace => {
  const firstScenario = workspace.scenarios[0]

  if (
    workspace.scenarios.length === 1 &&
    (LEGACY_PRESET_SOURCE_SHEETS.has(firstScenario.sourceSheet) ||
      LEGACY_PRESET_NAMES.has(firstScenario.name.trim().toLowerCase()) ||
      LEGACY_PRESET_SUMMARIES.has(firstScenario.summary.trim()) ||
      firstScenario.startingSnapshotLabel === 'Current net worth (Dec 2025)')
  ) {
    const scenario = createBlankScenario('Scenario 1')

    return {
      scenarios: [scenario],
      selectedScenarioId: scenario.id,
    }
  }

  return ensureDefaultScenarioName(workspace)
}

const normalizeHousingPlan = (entry: unknown): HousingPlan | null => {
  if (typeof entry !== 'object' || entry === null) {
    return null
  }

  const candidate = entry as Partial<HousingPlan>
  const defaults = createDefaultHousingPlan()

  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : defaults.enabled,
    homePrice: typeof candidate.homePrice === 'number' ? candidate.homePrice : defaults.homePrice,
    hoaAnnualCost:
      typeof candidate.hoaAnnualCost === 'number'
        ? candidate.hoaAnnualCost
        : defaults.hoaAnnualCost,
    purchaseYear:
      typeof candidate.purchaseYear === 'number'
        ? candidate.purchaseYear
        : defaults.purchaseYear,
    annualInterestRate:
      typeof candidate.annualInterestRate === 'number'
        ? candidate.annualInterestRate
        : defaults.annualInterestRate,
    mortgageTermYears:
      typeof candidate.mortgageTermYears === 'number'
        ? candidate.mortgageTermYears
        : defaults.mortgageTermYears,
    mortgageEndYear:
      typeof candidate.mortgageEndYear === 'number'
        ? candidate.mortgageEndYear
        : defaults.mortgageEndYear,
    downPaymentRate:
      typeof candidate.downPaymentRate === 'number'
        ? candidate.downPaymentRate
        : defaults.downPaymentRate,
    closingCostRate:
      typeof candidate.closingCostRate === 'number'
        ? candidate.closingCostRate
        : defaults.closingCostRate,
    propertyTaxRate:
      typeof candidate.propertyTaxRate === 'number'
        ? candidate.propertyTaxRate
        : defaults.propertyTaxRate,
    propertyTaxEndYear:
      typeof candidate.propertyTaxEndYear === 'number'
        ? candidate.propertyTaxEndYear
        : defaults.propertyTaxEndYear,
    saleYear: typeof candidate.saleYear === 'number' ? candidate.saleYear : defaults.saleYear,
    saleAppreciationRate:
      typeof candidate.saleAppreciationRate === 'number'
        ? candidate.saleAppreciationRate
        : defaults.saleAppreciationRate,
    saleOwnershipShare:
      typeof candidate.saleOwnershipShare === 'number'
        ? candidate.saleOwnershipShare
        : defaults.saleOwnershipShare,
  }
}

const normalizeScenario = (entry: unknown): Scenario | null => {
  const candidate = entry as Partial<Scenario> & {
    cashFlowItems?: unknown[]
    additionalHomes?: unknown[]
  }

  if (
    typeof entry !== 'object' ||
    entry === null ||
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    !Array.isArray(candidate.cashFlowItems)
  ) {
    return null
  }

  return {
    ...(candidate as Scenario),
    housing: normalizeHousingPlan(candidate.housing) ?? createDefaultHousingPlan(),
    additionalHomes: Array.isArray(candidate.additionalHomes)
      ? candidate.additionalHomes
          .map((home) => normalizeHousingPlan(home))
          .filter((home): home is HousingPlan => home !== null)
      : [],
    cashFlowItems: candidate.cashFlowItems.map((item) => {
      const cashFlowItem = item as Partial<CashFlowItem>

      return {
        id:
          typeof cashFlowItem.id === 'string' && cashFlowItem.id.trim().length > 0
            ? cashFlowItem.id
            : crypto.randomUUID(),
        kind:
          cashFlowItem.kind === 'income' || cashFlowItem.kind === 'expense'
            ? cashFlowItem.kind
            : null,
        label: typeof cashFlowItem.label === 'string' ? cashFlowItem.label : '',
        preTaxAmount:
          typeof cashFlowItem.preTaxAmount === 'number'
            ? cashFlowItem.preTaxAmount
            : null,
        amount: typeof cashFlowItem.amount === 'number' ? cashFlowItem.amount : null,
        startYear:
          typeof cashFlowItem.startYear === 'number'
            ? cashFlowItem.startYear
            : blankScenario.startYear,
        endYear:
          typeof cashFlowItem.endYear === 'number'
            ? cashFlowItem.endYear
            : blankScenario.startYear,
      }
    }),
    householdIncome:
      typeof candidate.householdIncome === 'number' ? candidate.householdIncome : null,
    workState: typeof candidate.workState === 'string' ? candidate.workState : 'California',
    incomeTaxRate:
      typeof candidate.incomeTaxRate === 'number' ? candidate.incomeTaxRate : null,
    incomeTaxBracketId:
      typeof candidate.incomeTaxBracketId === 'string'
        ? candidate.incomeTaxBracketId
        : DEFAULT_INCOME_TAX_BRACKET_ID,
    houseOwnershipPlan:
      candidate.houseOwnershipPlan === 'yes' || candidate.houseOwnershipPlan === 'no'
        ? candidate.houseOwnershipPlan
        : candidate.housing?.enabled
          ? 'yes'
          : 'no',
  }
}

const readLegacySavedScenarios = (): Scenario[] => {
  if (typeof window === 'undefined') {
    return []
  }

  try {
    window.localStorage.removeItem(LEGACY_SAVED_SCENARIOS_STORAGE_KEY)
    const storageKeys = [
      LEGACY_SAVED_SCENARIOS_STORAGE_KEY_V2,
      LEGACY_SAVED_SCENARIOS_STORAGE_KEY,
    ]

    for (const storageKey of storageKeys) {
      const rawValue = window.localStorage.getItem(storageKey)
      if (!rawValue) {
        continue
      }

      const parsed = JSON.parse(rawValue)
      if (!Array.isArray(parsed)) {
        continue
      }

      return parsed
        .map((entry) => normalizeScenario(entry))
        .filter((entry): entry is Scenario => entry !== null)
    }

    return []
  } catch {
    return []
  }
}

const readDraftScenario = (): Scenario | null => {
  if (typeof window === 'undefined') {
    return null
  }

  try {
    const rawValue = window.localStorage.getItem(DRAFT_SCENARIO_STORAGE_KEY)
    if (!rawValue) {
      return null
    }

    return normalizeScenario(JSON.parse(rawValue))
  } catch {
    return null
  }
}

const readScenarioWorkspace = (): ScenarioWorkspace => {
  if (typeof window === 'undefined') {
    const scenario = createBlankScenario('Scenario 1')

    return { scenarios: [scenario], selectedScenarioId: scenario.id }
  }

  try {
    const rawValue = window.localStorage.getItem(SCENARIOS_STORAGE_KEY)
    if (rawValue) {
      const parsed = JSON.parse(rawValue) as Partial<ScenarioWorkspace>
      const scenarios = Array.isArray(parsed.scenarios)
        ? parsed.scenarios
            .map((entry) => normalizeScenario(entry))
            .filter((entry): entry is Scenario => entry !== null)
        : []

      if (scenarios.length > 0) {
        const selectedScenarioId =
          typeof parsed.selectedScenarioId === 'string' &&
          scenarios.some((entry) => entry.id === parsed.selectedScenarioId)
            ? parsed.selectedScenarioId
            : scenarios[0].id

        return ensureDefaultWorkspace({ scenarios, selectedScenarioId })
      }
    }
  } catch {
    // Fall through to legacy migration.
  }

  const scenarios = [
    ...readLegacySavedScenarios(),
    ...[readDraftScenario()].filter((entry): entry is Scenario => entry !== null),
  ].map((entry) => ({
    ...entry,
    id:
      entry.id === 'blank-scenario' ||
      entry.id.trim().length === 0 ||
      entry.id.startsWith('saved-')
        ? createScenarioId()
        : entry.id,
    name: entry.name,
    startingSnapshotLabel:
      entry.startingSnapshotLabel || blankScenario.startingSnapshotLabel,
    sourceSheet: entry.sourceSheet ?? '',
    summary: entry.summary ?? '',
    currentNetWorth:
      typeof entry.currentNetWorth === 'number' ? entry.currentNetWorth : null,
    householdIncome:
      typeof entry.householdIncome === 'number' ? entry.householdIncome : null,
    workState: typeof entry.workState === 'string' ? entry.workState : 'California',
    incomeTaxRate:
      typeof entry.incomeTaxRate === 'number' ? entry.incomeTaxRate : null,
    goalNetWorth: typeof entry.goalNetWorth === 'number' ? entry.goalNetWorth : null,
    cashFlowItems: entry.cashFlowItems ?? [],
  }))
  const normalizedScenarios =
    scenarios.length > 0 ? scenarios : [createBlankScenario('Scenario 1')]
  const selectedScenarioId =
    normalizedScenarios.at(-1)?.id ?? normalizedScenarios[0].id

  return ensureDefaultWorkspace({
    scenarios: normalizedScenarios,
    selectedScenarioId,
  })
}

const writeScenarioWorkspace = (workspace: ScenarioWorkspace) => {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    SCENARIOS_STORAGE_KEY,
    JSON.stringify(workspace),
  )
}

function App() {
  const [workspace, setWorkspace] = useState<ScenarioWorkspace>(() =>
    readScenarioWorkspace(),
  )
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null)
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false)
  const [draggedCashFlowItemId, setDraggedCashFlowItemId] = useState<string | null>(null)
  const [dragOverCashFlowItemId, setDragOverCashFlowItemId] = useState<string | null>(null)
  const [openTypePickerItemId, setOpenTypePickerItemId] = useState<string | null>(null)
  const [editorColumnWidths, setEditorColumnWidths] = useState(
    DEFAULT_EDITOR_COLUMN_WIDTHS,
  )
  const [resizingColumnKey, setResizingColumnKey] =
    useState<EditorColumnKey | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [isAuthLoading, setIsAuthLoading] = useState(isSupabaseConfigured)
  const [isAuthSubmitting, setIsAuthSubmitting] = useState(false)
  const [authMode, setAuthMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [authEmail, setAuthEmail] = useState('')
  const [authPassword, setAuthPassword] = useState('')
  const [authMessage, setAuthMessage] = useState<string | null>(null)
  const [cloudStatus, setCloudStatus] = useState<string | null>(null)
  const [isCloudWorkspaceReady, setIsCloudWorkspaceReady] = useState(false)
  const [isTaxRateLoading, setIsTaxRateLoading] = useState(false)
  const [isTaxRateRefreshing, setIsTaxRateRefreshing] = useState(false)
  const [taxRateMessage, setTaxRateMessage] = useState<string | null>(null)
  const lastSyncedWorkspaceRef = useRef<string | null>(null)
  const taxRateRequestIdRef = useRef(0)
  const activeColumnResizeRef = useRef<{
    key: EditorColumnKey
    startX: number
    startWidth: number
  } | null>(null)
  const workspaceRef = useRef(workspace)

  const { scenarios, selectedScenarioId } = workspace
  const scenario =
    scenarios.find((entry) => entry.id === selectedScenarioId) ?? scenarios[0]

  const deferredScenario = useDeferredValue(scenario)
  const deferredScenarioWithHousingPlan = {
    ...deferredScenario,
    housing: {
      ...deferredScenario.housing,
      enabled: deferredScenario.houseOwnershipPlan === 'yes',
    },
    additionalHomes: deferredScenario.additionalHomes.map((home) => ({
      ...home,
      enabled: deferredScenario.houseOwnershipPlan === 'yes',
    })),
  }
  const scenarioWithHousingPlan = {
    ...scenario,
    housing: {
      ...scenario.housing,
      enabled: scenario.houseOwnershipPlan === 'yes',
    },
    additionalHomes: scenario.additionalHomes.map((home) => ({
      ...home,
      enabled: scenario.houseOwnershipPlan === 'yes',
    })),
  }
  const simulation = simulateScenario(deferredScenarioWithHousingPlan)
  const housingItems = [
    scenarioWithHousingPlan.housing,
    ...scenarioWithHousingPlan.additionalHomes,
  ].flatMap((home, index, homes) =>
    deriveHousingItems(home).map((item) => ({
      ...item,
      id: `home-${index + 1}-${item.id}`,
      label: homes.length > 1 ? `Home ${index + 1}: ${item.label}` : item.label,
    })),
  )
  const selectedIncomeTaxBracket =
    incomeTaxBrackets.find(
      (bracket) => bracket.id === deferredScenario.incomeTaxBracketId,
    ) ?? incomeTaxBrackets[0]
  const effectiveIncomeTaxRate =
    deferredScenario.incomeTaxRate ?? selectedIncomeTaxBracket.totalTaxRate
  const taxRateSourceUrl =
    scenario.householdIncome !== null &&
    scenario.householdIncome > 0 &&
    scenario.workState.trim().length > 0
      ? `https://www.talent.com/tax-calculator/${encodeURIComponent(
          scenario.workState.trim(),
        )}-${Math.round(scenario.householdIncome)}`
      : null
  const latestRow = simulation.yearlyRows.at(-1)
  const isRefreshing = deferredScenario !== scenario
  const signedInUserId = session?.user?.id ?? null
  const selectedScenarioIndex = scenarios.findIndex(
    (entry) => entry.id === selectedScenarioId,
  )
  const hasValidScenarioYearRange = scenario.startYear <= scenario.endYear
  const isCoreAssumptionsComplete =
    scenario.name.trim() !== '' &&
    scenario.currentNetWorth !== null &&
    hasValidScenarioYearRange
  const shouldShowHousingSection =
    isCoreAssumptionsComplete && scenario.houseOwnershipPlan === 'yes'
  const isHousingSectionComplete =
    scenario.houseOwnershipPlan === 'no' ||
    [scenarioWithHousingPlan.housing, ...scenarioWithHousingPlan.additionalHomes].every((home) =>
      isHousingPlanComplete(home, scenario),
    )
  const hasCompleteCashFlowRow = scenario.cashFlowItems.some(isCashFlowItemComplete)
  const canShowProjection =
    isCoreAssumptionsComplete && isHousingSectionComplete && hasCompleteCashFlowRow
  const editorCashFlowRows = [
    ...scenario.cashFlowItems.map((item) => ({
      item,
      isDerived: false,
    })),
    ...housingItems.map((item) => ({
      item,
      isDerived: true,
    })),
  ]

  const persistWorkspaceToCloud = useEffectEvent(
    async (workspaceToSave: ScenarioWorkspace) => {
      if (!supabase || !session?.user) {
        return false
      }

      const { error } = await supabase.from(WORKSPACE_TABLE).upsert(
        {
          user_id: session.user.id,
          workspace: workspaceToSave,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      )

      if (error) {
        setCloudStatus(error.message)
        return false
      }

      lastSyncedWorkspaceRef.current = JSON.stringify(workspaceToSave)
      setCloudStatus('Saved to cloud')
      return true
    },
  )

  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  useEffect(() => {
    writeScenarioWorkspace(workspace)
  }, [workspace])

  useEffect(() => {
    if (!supabase) {
      return
    }

    let isActive = true

    supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!isActive) {
          return
        }

        setSession(data.session)
        setIsAuthLoading(false)

        if (error) {
          setAuthMessage(error.message)
        }
      })
      .catch((error: unknown) => {
        if (!isActive) {
          return
        }

        setAuthMessage(
          error instanceof Error ? error.message : 'Unable to load auth session.',
        )
        setIsAuthLoading(false)
      })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!isActive) {
        return
      }

      setSession(nextSession)
      setIsAuthLoading(false)
      setIsDeleteConfirmOpen(false)

      if (!nextSession) {
        setCloudStatus('Signed out. Local autosave still works in this browser.')
        setIsCloudWorkspaceReady(false)
        lastSyncedWorkspaceRef.current = null
      }
    })

    return () => {
      isActive = false
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!supabase || !signedInUserId) {
      return
    }

    const supabaseClient = supabase
    let isActive = true
    const loadCloudWorkspace = async () => {
      setIsCloudWorkspaceReady(false)
      setCloudStatus('Loading cloud workspace...')

      const { data, error } = await supabaseClient
        .from(WORKSPACE_TABLE)
        .select('workspace')
        .eq('user_id', signedInUserId)
        .maybeSingle()

      if (!isActive) {
        return
      }

      if (error) {
        setCloudStatus(error.message)
        return
      }

      const remoteWorkspace = data?.workspace as ScenarioWorkspace | undefined

      if (remoteWorkspace) {
        const normalizedWorkspace = {
          scenarios: remoteWorkspace.scenarios
            .map((entry) => normalizeScenario(entry))
            .filter((entry): entry is Scenario => entry !== null),
          selectedScenarioId: remoteWorkspace.selectedScenarioId,
        }

        if (normalizedWorkspace.scenarios.length > 0) {
          const normalizedSelectedScenarioId = normalizedWorkspace.scenarios.some(
            (entry) => entry.id === normalizedWorkspace.selectedScenarioId,
          )
            ? normalizedWorkspace.selectedScenarioId
            : normalizedWorkspace.scenarios[0].id

          const nextWorkspace = {
            scenarios: normalizedWorkspace.scenarios,
            selectedScenarioId: normalizedSelectedScenarioId,
          }

          lastSyncedWorkspaceRef.current = JSON.stringify(nextWorkspace)
          setWorkspace(nextWorkspace)
          setCloudStatus(null)
          setIsCloudWorkspaceReady(true)
          return
        }
      }

      const didSeedCloudWorkspace = await persistWorkspaceToCloud(
        workspaceRef.current,
      )

      if (!isActive) {
        return
      }

      setCloudStatus(
        didSeedCloudWorkspace
          ? null
          : 'Unable to seed cloud workspace',
      )
      setIsCloudWorkspaceReady(didSeedCloudWorkspace)
    }

    void loadCloudWorkspace()

    return () => {
      isActive = false
    }
  }, [signedInUserId])

  useEffect(() => {
    if (!supabase || !signedInUserId || !isCloudWorkspaceReady) {
      return
    }

    const serializedWorkspace = JSON.stringify(workspace)
    if (serializedWorkspace === lastSyncedWorkspaceRef.current) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCloudStatus('Saving to cloud...')
      void persistWorkspaceToCloud(workspace)
    }, 500)

    return () => window.clearTimeout(timeoutId)
  }, [workspace, signedInUserId, isCloudWorkspaceReady])

  useEffect(() => {
    if (!saveFeedback) {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setSaveFeedback(null)
    }, 2500)

    return () => window.clearTimeout(timeoutId)
  }, [saveFeedback])

  useEffect(() => {
    if (!openTypePickerItemId) {
      return
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest('.type-pill-wrap')
      ) {
        return
      }

      setOpenTypePickerItemId(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenTypePickerItemId(null)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [openTypePickerItemId])

  useEffect(() => {
    if (!resizingColumnKey) {
      return
    }

    const handlePointerMove = (event: PointerEvent) => {
      const activeResize = activeColumnResizeRef.current

      if (!activeResize) {
        return
      }

      const nextWidth = Math.max(
        MIN_EDITOR_COLUMN_WIDTHS[activeResize.key],
        activeResize.startWidth + (event.clientX - activeResize.startX),
      )

      setEditorColumnWidths((current) =>
        current[activeResize.key] === nextWidth
          ? current
          : {
              ...current,
              [activeResize.key]: nextWidth,
            },
      )
    }

    const handlePointerUp = () => {
      activeColumnResizeRef.current = null
      setResizingColumnKey(null)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)

    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [resizingColumnKey])

  const updateScenario = (updater: (current: Scenario) => Scenario) => {
    setWorkspace((currentWorkspace) => ({
      ...currentWorkspace,
      scenarios: currentWorkspace.scenarios.map((currentScenario) =>
        currentScenario.id === currentWorkspace.selectedScenarioId
          ? updater(currentScenario)
          : currentScenario,
      ),
    }))
  }

  const selectScenario = (nextScenarioId: string) => {
    setIsDeleteConfirmOpen(false)
    setOpenTypePickerItemId(null)
    startTransition(() => {
      setWorkspace((currentWorkspace) => ({
        ...currentWorkspace,
        selectedScenarioId: nextScenarioId,
      }))
    })
  }

  const createScenario = () => {
    const nextScenario = createBlankScenario()

    setIsDeleteConfirmOpen(false)
    setOpenTypePickerItemId(null)
    startTransition(() => {
      setWorkspace((currentWorkspace) => ({
        scenarios: [...currentWorkspace.scenarios, nextScenario],
        selectedScenarioId: nextScenario.id,
      }))
    })
    setSaveFeedback('Created a new scenario')
  }

  const duplicateScenario = () => {
    const scenarioIndex = scenarios.findIndex((entry) => entry.id === selectedScenarioId)
    const scenarioLabel = getScenarioLabel(
      scenario,
      scenarioIndex >= 0 ? scenarioIndex : 0,
    )
    const duplicatedScenario = cloneScenario({
      ...scenario,
      id: createScenarioId(),
      name: `${scenarioLabel} copy`,
    })

    setIsDeleteConfirmOpen(false)
    setOpenTypePickerItemId(null)
    startTransition(() => {
      setWorkspace((currentWorkspace) => ({
        scenarios: [...currentWorkspace.scenarios, duplicatedScenario],
        selectedScenarioId: duplicatedScenario.id,
      }))
    })
    setSaveFeedback(`Duplicated "${scenarioLabel}"`)
  }

  const removeScenario = () => {
    const scenarioIndex = scenarios.findIndex((entry) => entry.id === selectedScenarioId)
    const scenarioLabel = getScenarioLabel(
      scenario,
      scenarioIndex >= 0 ? scenarioIndex : 0,
    )

    startTransition(() => {
      setWorkspace((currentWorkspace) => {
        const remainingScenarios = currentWorkspace.scenarios.filter(
          (entry) => entry.id !== currentWorkspace.selectedScenarioId,
        )

        if (remainingScenarios.length === 0) {
          const nextScenario = createBlankScenario('Scenario 1')

          return {
            scenarios: [nextScenario],
            selectedScenarioId: nextScenario.id,
          }
        }

        const nextScenario =
          remainingScenarios[Math.max(0, scenarioIndex - 1)] ?? remainingScenarios[0]

        return {
          scenarios: remainingScenarios,
          selectedScenarioId: nextScenario.id,
        }
      })
    })
    setIsDeleteConfirmOpen(false)
    setOpenTypePickerItemId(null)
    setSaveFeedback(`Removed "${scenarioLabel}"`)
  }

  const submitAuth = async () => {
    if (!supabase) {
      setAuthMessage('Add Supabase env vars before signing in.')
      return
    }

    if (!authEmail.trim() || !authPassword.trim()) {
      setAuthMessage('Enter both email and password.')
      return
    }

    setIsAuthSubmitting(true)
    setAuthMessage(null)

    const credentials = {
      email: authEmail.trim(),
      password: authPassword,
    }

    const { error } =
      authMode === 'sign-up'
        ? await supabase.auth.signUp(credentials)
        : await supabase.auth.signInWithPassword(credentials)

    if (error) {
      setAuthMessage(error.message)
      setIsAuthSubmitting(false)
      return
    }

    setAuthPassword('')
    setAuthMessage(
      authMode === 'sign-up'
        ? 'Account created. Check your email if confirmation is required, then sign in.'
        : 'Signed in successfully.',
    )
    setIsAuthSubmitting(false)
  }

  const signOut = async () => {
    if (!supabase) {
      return
    }

    const { error } = await supabase.auth.signOut()

    if (error) {
      setAuthMessage(error.message)
      return
    }

    setAuthMessage('Signed out successfully.')
  }

  const updateCashFlowItem = (
    itemId: string,
    field: keyof CashFlowItem,
    value: CashFlowItem[keyof CashFlowItem],
  ) => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: current.cashFlowItems.map((item) =>
        item.id === itemId ? { ...item, [field]: value } : item,
      ),
    }))
  }

  const setCashFlowItemKind = (itemId: string, nextKind: CashFlowItem['kind']) => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: current.cashFlowItems.map((item) =>
        item.id === itemId
          ? {
              ...item,
              kind: nextKind,
              preTaxAmount: nextKind === 'income' ? item.preTaxAmount : null,
            }
          : item,
      ),
    }))
    setOpenTypePickerItemId(null)
  }

  const removeCashFlowItem = (itemId: string) => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: current.cashFlowItems.filter((item) => item.id !== itemId),
    }))
    setOpenTypePickerItemId((current) => (current === itemId ? null : current))
  }

  const addCashFlowItem = () => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: [
        ...current.cashFlowItems,
        {
          id: crypto.randomUUID(),
          kind: null,
          label: 'New item',
          preTaxAmount: null,
          amount: 0,
          startYear: current.startYear,
          endYear: current.startYear,
        },
      ],
    }))
  }

  const sortCashFlowItemsByStartYear = () => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: [...current.cashFlowItems].sort((left, right) => {
        if (left.startYear !== right.startYear) {
          return left.startYear - right.startYear
        }

        if (left.endYear !== right.endYear) {
          return left.endYear - right.endYear
        }

        return left.label.localeCompare(right.label)
      }),
    }))
    setSaveFeedback('Sorted cash flow rows by start year')
  }

  const moveCashFlowItem = (draggedItemId: string, targetItemId: string) => {
    if (draggedItemId === targetItemId) {
      return
    }

    updateScenario((current) => {
      const nextItems = [...current.cashFlowItems]
      const draggedIndex = nextItems.findIndex((item) => item.id === draggedItemId)
      const targetIndex = nextItems.findIndex((item) => item.id === targetItemId)

      if (draggedIndex < 0 || targetIndex < 0) {
        return current
      }

      const [draggedItem] = nextItems.splice(draggedIndex, 1)
      nextItems.splice(targetIndex, 0, draggedItem)

      return {
        ...current,
        cashFlowItems: nextItems,
      }
    })
  }

  const startColumnResize = (
    columnKey: Exclude<EditorColumnKey, 'drag'>,
    clientX: number,
  ) => {
    activeColumnResizeRef.current = {
      key: columnKey,
      startX: clientX,
      startWidth: editorColumnWidths[columnKey],
    }
    setResizingColumnKey(columnKey)
  }

  const updatePrimaryHousing = (updater: (current: HousingPlan) => HousingPlan) => {
    updateScenario((current) => ({
      ...current,
      housing: updater(current.housing),
    }))
  }

  const updateAdditionalHousingAtIndex = (
    homeIndex: number,
    updater: (current: HousingPlan) => HousingPlan,
  ) => {
    updateScenario((current) => ({
      ...current,
      additionalHomes: current.additionalHomes.map((home, index) =>
        index === homeIndex ? updater(home) : home,
      ),
    }))
  }

  const addAdditionalHome = () => {
    updateScenario((current) => ({
      ...current,
      additionalHomes: [
        ...current.additionalHomes,
        {
          ...createDefaultHousingPlan(),
          enabled: current.houseOwnershipPlan === 'yes',
        },
      ],
    }))
  }

  const removeAdditionalHome = (homeIndex: number) => {
    updateScenario((current) => ({
      ...current,
      additionalHomes: current.additionalHomes.filter((_, index) => index !== homeIndex),
    }))
  }

  const renderHousingPlanEditor = (
    housing: HousingPlan,
    onUpdate: (updater: (current: HousingPlan) => HousingPlan) => void,
    options?: {
      title?: string
      onRemove?: () => void
    },
  ) => {
    const annualMortgageForHome = calculateAnnualMortgage(housing)
    const downPaymentForHome =
      housing.homePrice === null
        ? '—'
        : formatCurrency(housing.homePrice * housing.downPaymentRate)
    const saleProceedsForHome =
      housing.saleYear === null || housing.homePrice === null
        ? 'No sale'
        : formatCurrency(
            housing.homePrice *
              (1 + housing.saleAppreciationRate) *
              housing.saleOwnershipShare,
          )
    const homeItems = deriveHousingItems(housing)

    return (
      <div className="housing-home-block">
        {options?.title ? (
          <div className="housing-home-header">
            <h3>{options.title}</h3>
            {options.onRemove ? (
              <button className="ghost-button" type="button" onClick={options.onRemove}>
                Remove home
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="form-grid">
          <label className="field">
            <span>Home price</span>
            <FormattedNumberInput
              allowEmpty
              value={housing.homePrice}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  homePrice: value,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Purchase year</span>
            <FormattedNumberInput
              allowDecimal={false}
              useGrouping={false}
              value={housing.purchaseYear}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  purchaseYear: value ?? current.purchaseYear,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Annual interest rate</span>
            <FormattedNumberInput
              value={housing.annualInterestRate}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  annualInterestRate: value ?? current.annualInterestRate,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Mortgage term years</span>
            <FormattedNumberInput
              allowDecimal={false}
              value={housing.mortgageTermYears}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  mortgageTermYears: value ?? current.mortgageTermYears,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Sale year</span>
            <FormattedNumberInput
              allowDecimal={false}
              allowEmpty
              useGrouping={false}
              value={housing.saleYear}
              placeholder="No sale"
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  mortgageEndYear: value ?? current.mortgageEndYear,
                  propertyTaxEndYear: value ?? current.propertyTaxEndYear,
                  saleYear: value,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Down payment rate</span>
            <FormattedNumberInput
              value={housing.downPaymentRate}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  downPaymentRate: value ?? current.downPaymentRate,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Closing cost rate</span>
            <FormattedNumberInput
              value={housing.closingCostRate}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  closingCostRate: value ?? current.closingCostRate,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Property tax rate</span>
            <FormattedNumberInput
              value={housing.propertyTaxRate}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  propertyTaxRate: value ?? current.propertyTaxRate,
                }))
              }
            />
          </label>

          <label className="field">
            <span>HOA annual cost (optional)</span>
            <FormattedNumberInput
              allowEmpty
              value={housing.hoaAnnualCost}
              placeholder="Leave blank for none"
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  hoaAnnualCost: value,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Property tax end year</span>
            <input readOnly type="text" value={housing.saleYear ?? 'No sale'} />
          </label>

          <label className="field">
            <span>Mortgage end year</span>
            <input readOnly type="text" value={housing.saleYear ?? 'No sale'} />
          </label>

          <label className="field">
            <span>Sale appreciation rate</span>
            <FormattedNumberInput
              value={housing.saleAppreciationRate}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  saleAppreciationRate: value ?? current.saleAppreciationRate,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Ownership share sold</span>
            <FormattedNumberInput
              value={housing.saleOwnershipShare}
              onValueChange={(value) =>
                onUpdate((current) => ({
                  ...current,
                  saleOwnershipShare: value ?? current.saleOwnershipShare,
                }))
              }
            />
          </label>
        </div>

        <div className="derived-grid">
          <article className="derived-card">
            <span>Annual mortgage</span>
            <strong>{formatCurrency(annualMortgageForHome)}</strong>
          </article>
          <article className="derived-card">
            <span>Down payment</span>
            <strong>{downPaymentForHome}</strong>
          </article>
          <article className="derived-card">
            <span>Sale proceeds</span>
            <strong>{saleProceedsForHome}</strong>
          </article>
        </div>

        <div className="derived-list">
          <p className="mini-heading">Derived housing rows</p>
          {homeItems.length === 0 ? (
            <p className="empty-state">No housing-derived events in this home.</p>
          ) : (
            homeItems.map((item) => (
              <div className="derived-row" key={item.id}>
                <span>{item.label}</span>
                <span>
                  {formatCurrency(item.amount)} from {item.startYear} to {item.endYear}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    )
  }

  const renderLockedPanel = (
    kicker: string,
    title: string,
    message: string,
    detail?: string,
  ) => (
    <section className="panel full-width-panel panel-locked" aria-disabled="true">
      <div className="panel-header">
        <div>
          <p className="panel-kicker">{kicker}</p>
          <h2>{title}</h2>
        </div>
      </div>

      <div className="panel-locked-body">
        <p className="panel-locked-message">{message}</p>
        {detail ? <p className="panel-locked-detail">{detail}</p> : null}
      </div>
    </section>
  )

  const lookupTaxRate = async (
    householdIncome: number,
    workState: string,
    options?: { manual?: boolean },
  ) => {
    const isManual = options?.manual === true
    const requestId = taxRateRequestIdRef.current + 1
    taxRateRequestIdRef.current = requestId

    if (isManual) {
      setIsTaxRateLoading(true)
    }
    setIsTaxRateRefreshing(true)
    setTaxRateMessage('Updating average tax rate from Talent.com...')

    try {
      const result = await fetchAverageTaxRate(householdIncome, workState)

      if (taxRateRequestIdRef.current !== requestId) {
        return
      }

      updateScenario((current) => ({
        ...current,
        incomeTaxRate: result.averageTaxRate,
      }))
      setTaxRateMessage('Average tax rate updated from Talent.com.')
    } catch (error) {
      if (taxRateRequestIdRef.current !== requestId) {
        return
      }
      setTaxRateMessage(error instanceof Error ? error.message : 'Tax rate lookup failed.')
    } finally {
      if (taxRateRequestIdRef.current === requestId) {
        setIsTaxRateRefreshing(false)
      }
      if (isManual) {
        setIsTaxRateLoading(false)
      }
    }
  }

  useEffect(() => {
    if (scenario.householdIncome === null || scenario.householdIncome <= 0) {
      setIsTaxRateRefreshing(false)
      setTaxRateMessage('Enter total household income to calculate the average tax rate.')
      return
    }

    if (scenario.workState.trim().length === 0) {
      setIsTaxRateRefreshing(false)
      setTaxRateMessage('Select a state to calculate the average tax rate.')
      return
    }

    const timeoutId = window.setTimeout(() => {
      void lookupTaxRate(scenario.householdIncome ?? 0, scenario.workState)
    }, 450)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [scenario.householdIncome, scenario.workState])

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-header">
          <div className="hero-copy">
            <h1>Fire Calculator</h1>
          </div>

          <AuthPanel
            authMessage={authMessage}
            authMode={authMode}
            cloudStatus={cloudStatus}
            email={authEmail}
            isAuthLoading={isAuthLoading}
            isAuthSubmitting={isAuthSubmitting}
            isSupabaseConfigured={isSupabaseConfigured}
            onAuthModeChange={setAuthMode}
            onEmailChange={setAuthEmail}
            onPasswordChange={setAuthPassword}
            onSignOut={() => {
              void signOut()
            }}
            onSubmit={() => {
              void submitAuth()
            }}
            password={authPassword}
            userEmail={session?.user.email ?? null}
          />
        </div>

        <div className="hero-topbar">
          <div className="scenario-manager">
            <div className="scenario-manager-title">
              <span className="scenario-card-kicker">Scenario displayed</span>
            </div>

            <div className="scenario-toolbar">
              <label className="field scenario-select-field">
                <span className="sr-only">Select scenario</span>
                <select
                  aria-label="Select scenario"
                  value={selectedScenarioId}
                  onChange={(event) => selectScenario(event.target.value)}
                >
                  {scenarios.map((entry, index) => (
                    <option key={entry.id} value={entry.id}>
                      {getScenarioLabel(entry, index)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="scenario-actions">
                <button
                  className="ghost-button scenario-add-button"
                  type="button"
                  onClick={createScenario}
                  aria-label="Add new"
                  title="Add new"
                >
                  Add new
                </button>

                <button
                  className="ghost-button scenario-duplicate-button"
                  type="button"
                  onClick={duplicateScenario}
                >
                  Duplicate
                </button>

                <button
                  className="ghost-button scenario-delete-button"
                  type="button"
                  onClick={() => setIsDeleteConfirmOpen(true)}
                >
                  Delete selected
                </button>
              </div>
            </div>

            {isDeleteConfirmOpen ? (
              <div className="scenario-delete-confirm" role="alertdialog" aria-live="polite">
                <p className="scenario-delete-message">
                  Delete{' '}
                  <strong>
                    {getScenarioLabel(
                      scenario,
                      selectedScenarioIndex >= 0 ? selectedScenarioIndex : 0,
                    )}
                  </strong>
                  ? This can’t be undone.
                </p>
                <div className="scenario-delete-actions">
                  <button
                    className="ghost-button"
                    type="button"
                    onClick={() => setIsDeleteConfirmOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    className="ghost-button scenario-confirm-delete-button"
                    type="button"
                    onClick={removeScenario}
                  >
                    Yes, delete
                  </button>
                </div>
              </div>
            ) : null}

            {saveFeedback ? (
              <div className="scenario-meta">
                <p className="save-feedback hero-feedback">{saveFeedback}</p>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel full-width-panel">
          <div className="panel-header">
            <div>
              <h2>Core assumptions</h2>
            </div>
            {isRefreshing ? <span className="sync-pill">Refreshing</span> : null}
          </div>

          <div className="form-grid core-assumptions-grid">
            <label className="field field-span-4">
              <span>Scenario name</span>
              <input
                type="text"
                value={scenario.name}
                onChange={(event) =>
                  updateScenario((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                />
              </label>

            <label className="field">
              <span>Start year</span>
              <FormattedNumberInput
                allowDecimal={false}
                useGrouping={false}
                value={scenario.startYear}
                onValueChange={(value) =>
                  updateScenario((current) => ({
                    ...current,
                    startYear: value ?? current.startYear,
                  }))
                }
              />
            </label>

            <label className="field">
              <span>End year</span>
              <FormattedNumberInput
                allowDecimal={false}
                useGrouping={false}
                value={scenario.endYear}
                onValueChange={(value) =>
                  updateScenario((current) => ({
                    ...current,
                    endYear: value ?? current.endYear,
                  }))
                }
              />
            </label>

            <label className="field">
              <span>Starting net worth</span>
              <FormattedNumberInput
                allowEmpty
                value={scenario.currentNetWorth}
                onValueChange={(value) =>
                  updateScenario((current) => ({
                    ...current,
                    currentNetWorth: value,
                  }))
                }
              />
            </label>

            <label className="field">
              <span>Investment return rate</span>
              <FormattedNumberInput
                value={scenario.investmentReturnRate}
                onValueChange={(value) =>
                  updateScenario((current) => ({
                    ...current,
                    investmentReturnRate: value ?? current.investmentReturnRate,
                  }))
                }
                />
              </label>

            <label className="field">
              <span>Do you own or plan to own a house</span>
              <select
                value={scenario.houseOwnershipPlan}
                onChange={(event) =>
                  updateScenario((current) => ({
                    ...current,
                    houseOwnershipPlan: event.target.value as 'yes' | 'no',
                    housing: {
                      ...current.housing,
                      enabled: event.target.value === 'yes',
                    },
                  }))
                }
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </label>

            <label className="field">
              <span>Total household income</span>
              <FormattedNumberInput
                allowEmpty
                value={scenario.householdIncome}
                onValueChange={(value) =>
                  updateScenario((current) => ({
                    ...current,
                    householdIncome: value,
                  }))
                }
              />
            </label>

            <label className="field">
              <span>State</span>
              <select
                value={scenario.workState}
                onChange={(event) =>
                  updateScenario((current) => ({
                    ...current,
                    workState: event.target.value,
                  }))
                }
              >
                {usStates.map((state) => (
                  <option key={state} value={state}>
                    {state}
                  </option>
                ))}
              </select>
            </label>

            <div className="field field-span-3 tax-section">
              <div className="tax-grid">
                <label className="field tax-bracket-field">
                  <span className="tax-label-row">
                    <span>Average tax rate</span>
                    {taxRateSourceUrl ? (
                      <a
                        className="tax-source-link"
                        href={taxRateSourceUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        (source)
                      </a>
                    ) : null}
                  </span>
                  <input
                    type="text"
                    value={
                      scenario.incomeTaxRate !== null && !isTaxRateRefreshing
                        ? formatPercent(scenario.incomeTaxRate)
                        : isTaxRateRefreshing
                          ? 'Updating...'
                          : 'Enter income and state'
                    }
                    readOnly
                    aria-label="Average tax rate"
                  />
                </label>

                <label className="field tax-total-field">
                  <span>Tax lookup</span>
                  <button
                    className="ghost-button tax-refresh-button"
                    type="button"
                    onClick={() => {
                      if (
                        scenario.householdIncome !== null &&
                        scenario.householdIncome > 0 &&
                        scenario.workState.trim().length > 0
                      ) {
                        void lookupTaxRate(
                          scenario.householdIncome,
                          scenario.workState,
                          { manual: true },
                        )
                      }
                    }}
                    disabled={isTaxRateLoading}
                  >
                    {isTaxRateLoading ? 'Updating...' : 'Refresh from Talent.com'}
                  </button>
                  <span className="tax-source-note">
                    {taxRateMessage ?? 'Uses gross income and where you work to retrieve Average tax rate.'}
                  </span>
                </label>
              </div>
            </div>
          </div>
      </section>

      {shouldShowHousingSection ? (
        <section className="panel full-width-panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Housing</p>
              <h2>Home 1 purchase</h2>
            </div>
            <button className="ghost-button" type="button" onClick={addAdditionalHome}>
              Add another home
            </button>
          </div>

          {renderHousingPlanEditor(scenarioWithHousingPlan.housing, updatePrimaryHousing)}

          {scenarioWithHousingPlan.additionalHomes.map((home, index) => (
            <div className="additional-home-wrap" key={`additional-home-${index}`}>
              {renderHousingPlanEditor(
                home,
                (updater) => updateAdditionalHousingAtIndex(index, updater),
                {
                  title: `Home ${index + 2} purchase`,
                  onRemove: () => removeAdditionalHome(index),
                },
              )}
            </div>
          ))}
        </section>
      ) : null}

      <section className="panel full-width-panel">
        <div className="panel-header">
          <div>
            <p className="panel-kicker">Timeline</p>
            <h2>Cash flow editor</h2>
          </div>
          <button
            className="ghost-button"
            type="button"
            onClick={sortCashFlowItemsByStartYear}
          >
            Sort by start year
          </button>
        </div>

        <div className="table-wrap">
          <table className="editor-table">
            <colgroup>
              <col
                className="editor-col-drag"
                style={{ width: `${editorColumnWidths.drag}px` }}
              />
              <col
                className="editor-col-type"
                style={{ width: `${editorColumnWidths.type}px` }}
              />
              <col
                className="editor-col-label"
                style={{ width: `${editorColumnWidths.label}px` }}
              />
              <col
                className="editor-col-pretax"
                style={{ width: `${editorColumnWidths.pretax}px` }}
              />
              <col
                className="editor-col-amount"
                style={{ width: `${editorColumnWidths.amount}px` }}
              />
              <col
                className="editor-col-year"
                style={{ width: `${editorColumnWidths.start}px` }}
              />
              <col
                className="editor-col-year"
                style={{ width: `${editorColumnWidths.end}px` }}
              />
              <col
                className="editor-col-action"
                style={{ width: `${editorColumnWidths.action}px` }}
              />
            </colgroup>
            <thead>
              <tr>
                <th></th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span>Type</span>
                    <button
                      aria-label="Resize Type column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('type', event.clientX)
                      }
                    />
                  </div>
                </th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span>Label</span>
                    <button
                      aria-label="Resize Label column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('label', event.clientX)
                      }
                    />
                  </div>
                </th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span>Annual pre-tax amount</span>
                    <button
                      aria-label="Resize Annual pre-tax amount column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('pretax', event.clientX)
                      }
                    />
                  </div>
                </th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span>Annual post-tax amount</span>
                    <button
                      aria-label="Resize Annual post-tax amount column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('amount', event.clientX)
                      }
                    />
                  </div>
                </th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span>Start</span>
                    <button
                      aria-label="Resize Start column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('start', event.clientX)
                      }
                    />
                  </div>
                </th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span>End</span>
                    <button
                      aria-label="Resize End column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('end', event.clientX)
                      }
                    />
                  </div>
                </th>
                <th className="editor-resizable-th">
                  <div className="editor-th-content">
                    <span></span>
                    <button
                      aria-label="Resize actions column"
                      className="editor-resize-handle"
                      type="button"
                      onPointerDown={(event) =>
                        startColumnResize('action', event.clientX)
                      }
                    />
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {editorCashFlowRows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="editor-empty">
                    No cash flow rows yet. Click `Add row` to build a scenario from
                    scratch.
                  </td>
                </tr>
              ) : (
                editorCashFlowRows.map(({ item, isDerived }) => (
                  <tr
                    key={item.id}
                    className={[
                      isDerived ? 'editor-row-derived' : '',
                      !isDerived && draggedCashFlowItemId === item.id
                        ? 'editor-row-dragging'
                        : '',
                      !isDerived && dragOverCashFlowItemId === item.id
                        ? 'editor-row-target'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragEnter={(event) => {
                      if (isDerived) {
                        return
                      }
                      event.preventDefault()
                      if (draggedCashFlowItemId && draggedCashFlowItemId !== item.id) {
                        setDragOverCashFlowItemId(item.id)
                      }
                    }}
                    onDragOver={(event) => {
                      if (isDerived) {
                        return
                      }
                      event.preventDefault()
                      if (draggedCashFlowItemId && draggedCashFlowItemId !== item.id) {
                        event.dataTransfer.dropEffect = 'move'
                        if (dragOverCashFlowItemId !== item.id) {
                          setDragOverCashFlowItemId(item.id)
                        }
                      }
                    }}
                    onDrop={(event) => {
                      if (isDerived) {
                        return
                      }
                      event.preventDefault()
                      if (draggedCashFlowItemId) {
                        moveCashFlowItem(draggedCashFlowItemId, item.id)
                      }
                      setDraggedCashFlowItemId(null)
                      setDragOverCashFlowItemId(null)
                    }}
                  >
                      <td className="editor-drag-cell">
                        {isDerived ? (
                          <span className="editor-derived-tag">Auto</span>
                        ) : (
                          <button
                            aria-label={`Drag to reorder ${item.label || 'cash flow row'}`}
                            className="editor-drag-handle"
                            draggable
                            type="button"
                            onDragStart={(event) => {
                              setDraggedCashFlowItemId(item.id)
                              event.dataTransfer.effectAllowed = 'move'
                              event.dataTransfer.setData('text/plain', item.id)
                            }}
                            onDragEnd={() => {
                              setDraggedCashFlowItemId(null)
                              setDragOverCashFlowItemId(null)
                            }}
                            title="Drag to reorder"
                          >
                            ⋮⋮
                          </button>
                        )}
                      </td>
                      <td>
                        <div className="type-pill-wrap">
                          {isDerived ? (
                            <span
                              className={[
                                'type-pill',
                                'type-pill-static',
                                item.kind === 'income'
                                  ? 'type-pill-income'
                                  : item.kind === 'expense'
                                    ? 'type-pill-expense'
                                    : 'type-pill-neutral',
                              ]
                                .filter(Boolean)
                                .join(' ')}
                            >
                              {item.kind === 'income'
                                ? 'Income'
                                : item.kind === 'expense'
                                  ? 'Expense'
                                  : 'Select type'}
                            </span>
                          ) : (
                            <>
                              <button
                                aria-expanded={openTypePickerItemId === item.id}
                                aria-haspopup="menu"
                                aria-label={`Choose type for ${item.label || 'cash flow row'}`}
                                className={[
                                  'type-pill',
                                  'type-pill-button',
                                  item.kind === 'income'
                                    ? 'type-pill-income'
                                    : item.kind === 'expense'
                                      ? 'type-pill-expense'
                                      : 'type-pill-neutral',
                                ]
                                  .filter(Boolean)
                                  .join(' ')}
                                onClick={() =>
                                  setOpenTypePickerItemId((current) =>
                                    current === item.id ? null : item.id,
                                  )
                                }
                                type="button"
                              >
                                <span>
                                  {item.kind === 'income'
                                    ? 'Income'
                                    : item.kind === 'expense'
                                      ? 'Expense'
                                      : 'Select type'}
                                </span>
                                <span aria-hidden="true" className="type-pill-caret">
                                  ▾
                                </span>
                              </button>

                              {openTypePickerItemId === item.id ? (
                                <div className="type-pill-menu" role="menu">
                                  <button
                                    aria-checked={item.kind === 'income'}
                                    className={[
                                      'type-pill-option',
                                      'type-pill-option-income',
                                      item.kind === 'income'
                                        ? 'type-pill-option-active'
                                        : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                    onClick={() => setCashFlowItemKind(item.id, 'income')}
                                    role="menuitemradio"
                                    type="button"
                                  >
                                    Income
                                  </button>
                                  <button
                                    aria-checked={item.kind === 'expense'}
                                    className={[
                                      'type-pill-option',
                                      'type-pill-option-expense',
                                      item.kind === 'expense'
                                        ? 'type-pill-option-active'
                                        : '',
                                    ]
                                      .filter(Boolean)
                                      .join(' ')}
                                    onClick={() => setCashFlowItemKind(item.id, 'expense')}
                                    role="menuitemradio"
                                    type="button"
                                  >
                                    Expense
                                  </button>
                                </div>
                              ) : null}
                            </>
                          )}
                        </div>
                      </td>
                      <td>
                        {isDerived ? (
                          <div className="editor-derived-label">
                            <span>{item.label}</span>
                            <span className="editor-derived-badge">Derived housing row</span>
                          </div>
                        ) : (
                          <input
                            type="text"
                            value={item.label}
                            onChange={(event) =>
                              updateCashFlowItem(item.id, 'label', event.target.value)
                            }
                          />
                        )}
                      </td>
                      <td>
                        {isDerived ? (
                          <span className="editor-static-value">-</span>
                        ) : item.kind === 'income' ? (
                          <FormattedNumberInput
                            allowEmpty
                            value={item.preTaxAmount}
                            onValueChange={(value) =>
                              updateCashFlowItem(item.id, 'preTaxAmount', value)
                            }
                          />
                        ) : item.kind === null ? (
                          <span className="editor-muted">Select type</span>
                        ) : (
                          <span className="editor-muted">-</span>
                        )}
                      </td>
                      <td>
                        {isDerived ? (
                          <span className="editor-static-value">
                            {formatCurrency(
                              resolveCashFlowAmount(
                                item,
                                effectiveIncomeTaxRate,
                              ) ?? 0,
                            )}
                          </span>
                        ) : item.kind === null ? (
                          <span className="editor-muted">Select type</span>
                        ) : (
                          <FormattedNumberInput
                            allowEmpty
                            value={resolveCashFlowAmount(
                              item,
                              effectiveIncomeTaxRate,
                            )}
                            readOnly={item.kind === 'income' && item.preTaxAmount !== null}
                            onValueChange={(value) =>
                              updateCashFlowItem(item.id, 'amount', value)
                            }
                          />
                        )}
                      </td>
                      <td>
                        {isDerived ? (
                          <span className="editor-static-value">{item.startYear}</span>
                        ) : (
                          <FormattedNumberInput
                            allowDecimal={false}
                            useGrouping={false}
                            value={item.startYear}
                            onValueChange={(value) =>
                              updateCashFlowItem(
                                item.id,
                                'startYear',
                                value ?? item.startYear,
                              )
                            }
                          />
                        )}
                      </td>
                      <td>
                        {isDerived ? (
                          <span className="editor-static-value">{item.endYear}</span>
                        ) : (
                          <FormattedNumberInput
                            allowDecimal={false}
                            useGrouping={false}
                            value={item.endYear}
                            onValueChange={(value) =>
                              updateCashFlowItem(
                                item.id,
                                'endYear',
                                value ?? item.endYear,
                              )
                            }
                          />
                        )}
                      </td>
                      <td>
                        {isDerived ? (
                          <span className="editor-static-value">Derived</span>
                        ) : (
                          <button
                            className="icon-button"
                            type="button"
                            onClick={() => removeCashFlowItem(item.id)}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="editor-footer">
          <button className="ghost-button" type="button" onClick={addCashFlowItem}>
            Add row
          </button>
        </div>
      </section>

      {canShowProjection ? (
        <>
          <section className="panel full-width-panel chart-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Projection</p>
                <h2>Net worth trajectory</h2>
              </div>
              <div className="chart-stats">
                <span>Peak {formatCurrencyCompact(simulation.peakNetWorth)}</span>
                <span>{formatPercent(deferredScenario.investmentReturnRate)} growth</span>
              </div>
            </div>

            <div className="chart-frame">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={simulation.yearlyRows}>
                  <CartesianGrid stroke="rgba(154, 123, 93, 0.18)" vertical={false} />
                  <XAxis dataKey="year" tickLine={false} axisLine={false} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatCurrencyCompact(value)}
                    width={96}
                  />
                  <Tooltip
                    formatter={(value) =>
                      formatCurrency(
                        typeof value === 'number' ? value : Number(value ?? 0),
                      )
                    }
                    labelFormatter={(label) => `Year ${label}`}
                  />
                  {deferredScenario.goalNetWorth !== null ? (
                    <ReferenceLine
                      y={deferredScenario.goalNetWorth}
                      stroke="#D89A4E"
                      strokeDasharray="4 4"
                    />
                  ) : null}
                  <Line
                    type="monotone"
                    dataKey="closingNetWorth"
                    stroke="#1F3A4A"
                    strokeWidth={3}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="snapshot-grid">
              <article className="snapshot-card">
                <span>First projected year</span>
                <strong>{simulation.yearlyRows[0]?.year}</strong>
                <p>
                  {formatCurrency(simulation.yearlyRows[0]?.closingNetWorth ?? 0)} closing
                  net worth
                </p>
              </article>
              <article className="snapshot-card">
                <span>Last projected year</span>
                <strong>{latestRow?.year}</strong>
                <p>{formatCurrency(latestRow?.closingNetWorth ?? 0)} closing net worth</p>
              </article>
              <article className="snapshot-card">
                <span>Active cash flow rows</span>
                <strong>{simulation.allCashFlowItems.length}</strong>
                <p>Editable timeline rows plus derived housing events</p>
              </article>
            </div>
          </section>

          <section className="panel full-width-panel">
            <div className="panel-header">
              <div>
                <p className="panel-kicker">Results</p>
                <h2>Year-by-year table</h2>
              </div>
              <span className="table-note">
                {scenarios.length === 1
                  ? '1 scenario autosaved'
                  : `${scenarios.length} scenarios autosaved`}
              </span>
            </div>

            <div className="table-wrap projection-wrap">
              <table className="projection-table">
                <thead>
                  <tr>
                    <th>Year</th>
                    <th>Expenses</th>
                    <th>Income</th>
                    <th>Growth</th>
                    <th>Closing net worth</th>
                  </tr>
                </thead>
                <tbody>
                  {simulation.yearlyRows.map((row) => (
                    <tr key={row.year} className={row.goalReached ? 'goal-row' : ''}>
                      <td>{row.year}</td>
                      <td>{formatCurrency(row.expenses)}</td>
                      <td>{formatCurrency(row.income)}</td>
                      <td>{formatCurrency(row.investmentGrowth)}</td>
                      <td>{formatCurrency(row.closingNetWorth)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : (
        <>
          {renderLockedPanel(
            'Projection',
            'Net worth trajectory',
            'Add at least one complete cash flow row to unlock the projection.',
            'A complete row needs a type, label, amount, and a valid start/end year.',
          )}
          {renderLockedPanel(
            'Results',
            'Year-by-year table',
            'The results table will appear after the first complete cash flow row.',
          )}
        </>
      )}

    </main>
  )
}

export default App
