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
import { formatCurrency, formatCurrencyCompact, formatPercent } from './lib/formatters'
import {
  resolveCashFlowAmount,
  calculateAnnualMortgage,
  deriveHousingItems,
  simulateScenario,
} from './lib/simulate'
import type { CashFlowItem, Scenario, ScenarioWorkspace } from './types'
import { FormattedNumberInput } from './components/FormattedNumberInput'
import { AuthPanel } from './components/AuthPanel'
import { isSupabaseConfigured, supabase } from './lib/supabase'

const cloneScenario = (scenario: Scenario) => structuredClone(scenario)
const SCENARIOS_STORAGE_KEY = 'fire-calculator-scenarios-v1'
const LEGACY_SAVED_SCENARIOS_STORAGE_KEY = 'fire-calculator-saved-scenarios-v1'
const LEGACY_SAVED_SCENARIOS_STORAGE_KEY_V2 = 'fire-calculator-saved-scenarios-v2'
const DRAFT_SCENARIO_STORAGE_KEY = 'fire-calculator-draft-scenario-v1'
const WORKSPACE_TABLE = 'user_workspaces'

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
  type: 124,
  label: 320,
  pretax: 220,
  amount: 220,
  start: 110,
  end: 110,
  action: 128,
}

const MIN_EDITOR_COLUMN_WIDTHS: Record<EditorColumnKey, number> = {
  drag: 44,
  type: 96,
  label: 180,
  pretax: 160,
  amount: 160,
  start: 88,
  end: 88,
  action: 112,
}

const blankScenario: Scenario = {
  id: 'blank-scenario',
  name: '',
  summary: '',
  sourceSheet: '',
  startingSnapshotLabel: 'Enter your starting net worth',
  currentNetWorth: null,
  startYear: 2026,
  endYear: 2060,
  investmentReturnRate: 0.04,
  incomeTaxBracketId: DEFAULT_INCOME_TAX_BRACKET_ID,
  goalNetWorth: null,
  housing: {
    enabled: false,
    homePrice: null,
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
  },
  cashFlowItems: [],
}

const createScenarioId = () => `scenario-${crypto.randomUUID()}`

const createBlankScenario = () =>
  cloneScenario({
    ...blankScenario,
    id: createScenarioId(),
  })

const getScenarioLabel = (scenario: Scenario, index: number) =>
  scenario.name.trim() || `Untitled scenario ${index + 1}`

const normalizeScenario = (entry: unknown): Scenario | null => {
  const candidate = entry as Partial<Scenario> & { cashFlowItems?: unknown[] }

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
    cashFlowItems: candidate.cashFlowItems.map((item) => {
      const cashFlowItem = item as CashFlowItem

      return {
        ...cashFlowItem,
        preTaxAmount:
          typeof cashFlowItem.preTaxAmount === 'number'
            ? cashFlowItem.preTaxAmount
            : null,
      }
    }),
    incomeTaxBracketId:
      typeof candidate.incomeTaxBracketId === 'string'
        ? candidate.incomeTaxBracketId
        : DEFAULT_INCOME_TAX_BRACKET_ID,
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
    const scenario = createBlankScenario()

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

        return { scenarios, selectedScenarioId }
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
    goalNetWorth: typeof entry.goalNetWorth === 'number' ? entry.goalNetWorth : null,
    cashFlowItems: entry.cashFlowItems ?? [],
  }))
  const normalizedScenarios = scenarios.length > 0 ? scenarios : [createBlankScenario()]
  const selectedScenarioId =
    normalizedScenarios.at(-1)?.id ?? normalizedScenarios[0].id

  return { scenarios: normalizedScenarios, selectedScenarioId }
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
  const lastSyncedWorkspaceRef = useRef<string | null>(null)
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
  const simulation = simulateScenario(deferredScenario)
  const housingItems = deriveHousingItems(deferredScenario.housing)
  const annualMortgage = calculateAnnualMortgage(deferredScenario.housing)
  const selectedIncomeTaxBracket =
    incomeTaxBrackets.find(
      (bracket) => bracket.id === deferredScenario.incomeTaxBracketId,
    ) ?? incomeTaxBrackets[0]
  const latestRow = simulation.yearlyRows.at(-1)
  const isRefreshing = deferredScenario !== scenario
  const signedInUserId = session?.user?.id ?? null
  const selectedScenarioIndex = scenarios.findIndex(
    (entry) => entry.id === selectedScenarioId,
  )
  const currentNetWorthLabel =
    deferredScenario.currentNetWorth === null
      ? '—'
      : formatCurrencyCompact(deferredScenario.currentNetWorth)
  const downPaymentLabel =
    scenario.housing.homePrice === null
      ? '—'
      : formatCurrency(
          scenario.housing.homePrice * scenario.housing.downPaymentRate,
        )
  const saleProceedsLabel =
    scenario.housing.saleYear === null || scenario.housing.homePrice === null
      ? 'No sale'
      : formatCurrency(
          scenario.housing.homePrice *
            (1 + scenario.housing.saleAppreciationRate) *
            scenario.housing.saleOwnershipShare,
        )

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
          const nextScenario = createBlankScenario()

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

  const removeCashFlowItem = (itemId: string) => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: current.cashFlowItems.filter((item) => item.id !== itemId),
    }))
  }

  const addCashFlowItem = () => {
    updateScenario((current) => ({
      ...current,
      cashFlowItems: [
        ...current.cashFlowItems,
        {
          id: crypto.randomUUID(),
          kind: 'expense',
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

  return (
    <main className="app-shell">
      <section className="hero-panel">
        <div className="hero-topbar">
          <div className="hero-copy">
            <p className="eyebrow">Spreadsheet MVP</p>
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

        <div className="hero-controls">
          <div className="scenario-manager scenario-card">
            <div className="scenario-manager-header">
              <div>
                <span className="scenario-card-kicker">Scenarios</span>
                <p className="scenario-card-note">
                  Switch between scenarios, add a new one, or remove the selected
                  scenario.
                </p>
              </div>
              <button
                className="icon-button scenario-add-button"
                type="button"
                onClick={createScenario}
                aria-label="Add new scenario"
                title="Add new scenario"
              >
                +
              </button>
            </div>

            <div className="scenario-toolbar">
              <label className="field scenario-select-field">
                <span>Select scenario</span>
                <select
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

            <p className="scenario-card-note">
              {scenarios.length === 1
                ? '1 scenario in your workspace.'
                : `${scenarios.length} scenarios in your workspace.`}{' '}
              Current: {' '}
              {getScenarioLabel(
                scenario,
                selectedScenarioIndex >= 0 ? selectedScenarioIndex : 0,
              )}
              .
            </p>

            <p className="save-feedback hero-feedback">
              {saveFeedback ?? 'Every scenario autosaves as you edit it.'}
            </p>
          </div>
        </div>

        <div className="metric-grid">
          <article className="metric-card">
            <span className="metric-label">Starting net worth</span>
            <strong>{currentNetWorthLabel}</strong>
            <p>{deferredScenario.startingSnapshotLabel}</p>
          </article>

          <article className="metric-card">
            <span className="metric-label">Target</span>
            <strong>{formatCurrency(deferredScenario.goalNetWorth)}</strong>
            <p>
              {deferredScenario.goalNetWorth === null
                ? 'Open-ended scenario'
                : 'Editable FIRE milestone'}
            </p>
          </article>

          <article className="metric-card">
              <span className="metric-label">Retirement year</span>
              <strong>
                {simulation.retirementYear ??
                  (deferredScenario.goalNetWorth === null ? 'Unset' : 'Not hit')}
              </strong>
              <p>
                {getScenarioLabel(
                  scenario,
                  selectedScenarioIndex >= 0 ? selectedScenarioIndex : 0,
                )}
              </p>
            </article>

          <article className="metric-card">
            <span className="metric-label">End of horizon</span>
            <strong>{formatCurrencyCompact(simulation.finalNetWorth)}</strong>
            <p>{deferredScenario.endYear}</p>
          </article>
        </div>
      </section>

      <section className="top-grid">
        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Scenario</p>
              <h2>Core assumptions</h2>
            </div>
            {isRefreshing ? <span className="sync-pill">Refreshing</span> : null}
          </div>

          <div className="form-grid">
            <label className="field field-span-2">
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

            <label className="field field-span-2">
              <span>Scenario description</span>
              <textarea
                className="field-textarea"
                value={scenario.summary}
                onChange={(event) =>
                  updateScenario((current) => ({
                    ...current,
                    summary: event.target.value,
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
              <span>Goal net worth</span>
              <FormattedNumberInput
                allowEmpty
                value={scenario.goalNetWorth}
                placeholder="Leave blank for none"
                onValueChange={(value) =>
                  updateScenario((current) => ({
                    ...current,
                    goalNetWorth: value,
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

            <div className="field field-span-2 tax-section">
              <div className="tax-section-header">
                <span>Income tax</span>
                <a
                  className="source-link"
                  href={selectedIncomeTaxBracket.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Source
                </a>
              </div>

              <div className="tax-grid">
                <label className="field">
                  <span>Income tax bracket</span>
                  <select
                    value={scenario.incomeTaxBracketId}
                    onChange={(event) =>
                      updateScenario((current) => ({
                        ...current,
                        incomeTaxBracketId: event.target.value,
                      }))
                    }
                  >
                    {incomeTaxBrackets.map((bracket) => (
                      <option key={bracket.id} value={bracket.id}>
                        {bracket.label}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="tax-output">
                  <span>Total tax</span>
                  <strong>{formatPercent(selectedIncomeTaxBracket.totalTaxRate)}</strong>
                  <p>{selectedIncomeTaxBracket.sourceLabel}</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <div>
              <p className="panel-kicker">Housing</p>
              <h2>Derived home model</h2>
            </div>
          </div>

          <label className="toggle">
            <input
              type="checkbox"
              checked={scenario.housing.enabled}
              onChange={(event) =>
                updateScenario((current) => ({
                  ...current,
                  housing: { ...current.housing, enabled: event.target.checked },
                }))
              }
            />
            <span>Enable purchase and sale events</span>
          </label>

          {scenario.housing.enabled ? (
            <>
              <div className="form-grid">
                <label className="field">
                  <span>Home price</span>
                  <FormattedNumberInput
                    allowEmpty
                    value={scenario.housing.homePrice}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          homePrice: value,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Purchase year</span>
                  <FormattedNumberInput
                    allowDecimal={false}
                    useGrouping={false}
                    value={scenario.housing.purchaseYear}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          purchaseYear: value ?? current.housing.purchaseYear,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Annual interest rate</span>
                  <FormattedNumberInput
                    value={scenario.housing.annualInterestRate}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          annualInterestRate: value ?? current.housing.annualInterestRate,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Mortgage term years</span>
                  <FormattedNumberInput
                    allowDecimal={false}
                    value={scenario.housing.mortgageTermYears}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          mortgageTermYears: value ?? current.housing.mortgageTermYears,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Mortgage end year</span>
                  <input
                    readOnly
                    type="text"
                    value={scenario.housing.saleYear ?? 'No sale'}
                  />
                </label>

                <label className="field">
                  <span>Down payment rate</span>
                  <FormattedNumberInput
                    value={scenario.housing.downPaymentRate}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          downPaymentRate: value ?? current.housing.downPaymentRate,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Closing cost rate</span>
                  <FormattedNumberInput
                    value={scenario.housing.closingCostRate}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          closingCostRate: value ?? current.housing.closingCostRate,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Property tax rate</span>
                  <FormattedNumberInput
                    value={scenario.housing.propertyTaxRate}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          propertyTaxRate: value ?? current.housing.propertyTaxRate,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Property tax end year</span>
                  <input
                    readOnly
                    type="text"
                    value={scenario.housing.saleYear ?? 'No sale'}
                  />
                </label>

                <label className="field">
                  <span>Sale year</span>
                  <FormattedNumberInput
                    allowDecimal={false}
                    allowEmpty
                    useGrouping={false}
                    value={scenario.housing.saleYear}
                    placeholder="No sale"
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          mortgageEndYear:
                            value ?? current.housing.mortgageEndYear,
                          propertyTaxEndYear:
                            value ?? current.housing.propertyTaxEndYear,
                          saleYear: value,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Sale appreciation rate</span>
                  <FormattedNumberInput
                    value={scenario.housing.saleAppreciationRate}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          saleAppreciationRate:
                            value ?? current.housing.saleAppreciationRate,
                        },
                      }))
                    }
                  />
                </label>

                <label className="field">
                  <span>Ownership share sold</span>
                  <FormattedNumberInput
                    value={scenario.housing.saleOwnershipShare}
                    onValueChange={(value) =>
                      updateScenario((current) => ({
                        ...current,
                        housing: {
                          ...current.housing,
                          saleOwnershipShare:
                            value ?? current.housing.saleOwnershipShare,
                        },
                      }))
                    }
                  />
                </label>
              </div>

              <div className="derived-grid">
                <article className="derived-card">
                  <span>Annual mortgage</span>
                  <strong>{formatCurrency(annualMortgage)}</strong>
                </article>
                <article className="derived-card">
                  <span>Down payment</span>
                  <strong>{downPaymentLabel}</strong>
                </article>
                <article className="derived-card">
                  <span>Sale proceeds</span>
                  <strong>{saleProceedsLabel}</strong>
                </article>
              </div>

              <div className="derived-list">
                <p className="mini-heading">Derived housing rows</p>
                {housingItems.length === 0 ? (
                  <p className="empty-state">No housing-derived events in this scenario.</p>
                ) : (
                  housingItems.map((item) => (
                    <div className="derived-row" key={item.id}>
                      <span>{item.label}</span>
                      <span>
                        {formatCurrency(item.amount)} from {item.startYear} to {item.endYear}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : null}
        </section>
      </section>

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
              {scenario.cashFlowItems.length === 0 ? (
                <tr>
                  <td colSpan={8} className="editor-empty">
                    No cash flow rows yet. Click `Add row` to build a scenario from
                    scratch.
                  </td>
                </tr>
              ) : (
                scenario.cashFlowItems.map((item) => (
                  <tr
                    key={item.id}
                    className={[
                      item.kind === 'income'
                        ? 'editor-row-income'
                        : 'editor-row-expense',
                      draggedCashFlowItemId === item.id ? 'editor-row-dragging' : '',
                      dragOverCashFlowItemId === item.id ? 'editor-row-target' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onDragEnter={(event) => {
                      event.preventDefault()
                      if (draggedCashFlowItemId && draggedCashFlowItemId !== item.id) {
                        setDragOverCashFlowItemId(item.id)
                      }
                    }}
                    onDragOver={(event) => {
                      event.preventDefault()
                      if (draggedCashFlowItemId && draggedCashFlowItemId !== item.id) {
                        event.dataTransfer.dropEffect = 'move'
                        if (dragOverCashFlowItemId !== item.id) {
                          setDragOverCashFlowItemId(item.id)
                        }
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggedCashFlowItemId) {
                        moveCashFlowItem(draggedCashFlowItemId, item.id)
                      }
                      setDraggedCashFlowItemId(null)
                      setDragOverCashFlowItemId(null)
                    }}
                  >
                    <td className="editor-drag-cell">
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
                    </td>
                    <td>
                      <select
                        value={item.kind}
                        onChange={(event) =>
                          updateScenario((current) => ({
                            ...current,
                            cashFlowItems: current.cashFlowItems.map((currentItem) =>
                              currentItem.id === item.id
                                ? {
                                    ...currentItem,
                                    kind: event.target.value as CashFlowItem['kind'],
                                    preTaxAmount:
                                      event.target.value === 'income'
                                        ? currentItem.preTaxAmount
                                        : null,
                                  }
                                : currentItem,
                            ),
                          }))
                        }
                      >
                        <option value="expense">Expense</option>
                        <option value="income">Income</option>
                      </select>
                    </td>
                    <td>
                      <input
                        type="text"
                        value={item.label}
                        onChange={(event) =>
                          updateCashFlowItem(item.id, 'label', event.target.value)
                        }
                      />
                    </td>
                    <td>
                      {item.kind === 'income' ? (
                        <FormattedNumberInput
                          allowEmpty
                          value={item.preTaxAmount}
                          onValueChange={(value) =>
                            updateCashFlowItem(item.id, 'preTaxAmount', value)
                          }
                        />
                      ) : (
                        <span className="editor-muted">-</span>
                      )}
                    </td>
                    <td>
                      <FormattedNumberInput
                        allowEmpty
                        value={resolveCashFlowAmount(
                          item,
                          selectedIncomeTaxBracket.totalTaxRate,
                        )}
                        readOnly={item.kind === 'income' && item.preTaxAmount !== null}
                        onValueChange={(value) =>
                          updateCashFlowItem(item.id, 'amount', value)
                        }
                      />
                    </td>
                    <td>
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
                    </td>
                    <td>
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
                    </td>
                    <td>
                      <button
                        className="icon-button"
                        type="button"
                        onClick={() => removeCashFlowItem(item.id)}
                      >
                        Remove
                      </button>
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
                <CartesianGrid stroke="rgba(25, 49, 75, 0.08)" vertical={false} />
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
                    stroke="#b06432"
                    strokeDasharray="4 4"
                  />
                ) : null}
                <Line
                  type="monotone"
                  dataKey="closingNetWorth"
                  stroke="#143d59"
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

    </main>
  )
}

export default App
