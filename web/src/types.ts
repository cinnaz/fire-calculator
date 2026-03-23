export type CashFlowKind = 'income' | 'expense'

export interface CashFlowItem {
  id: string
  kind: CashFlowKind
  label: string
  preTaxAmount: number | null
  amount: number | null
  startYear: number
  endYear: number
}

export interface HousingPlan {
  enabled: boolean
  homePrice: number | null
  purchaseYear: number
  annualInterestRate: number
  mortgageTermYears: number
  mortgageEndYear: number
  downPaymentRate: number
  closingCostRate: number
  propertyTaxRate: number
  propertyTaxEndYear: number
  saleYear: number | null
  saleAppreciationRate: number
  saleOwnershipShare: number
}

export interface Scenario {
  id: string
  name: string
  summary: string
  sourceSheet: string
  startingSnapshotLabel: string
  currentNetWorth: number | null
  startYear: number
  endYear: number
  investmentReturnRate: number
  incomeTaxBracketId: string
  goalNetWorth: number | null
  housing: HousingPlan
  cashFlowItems: CashFlowItem[]
}

export interface ScenarioWorkspace {
  scenarios: Scenario[]
  selectedScenarioId: string
}

export interface YearlyProjection {
  year: number
  openingNetWorth: number
  expenses: number
  income: number
  investmentGrowth: number
  closingNetWorth: number
  goalReached: boolean
}

export interface SimulationResult {
  allCashFlowItems: CashFlowItem[]
  yearlyRows: YearlyProjection[]
  retirementYear: number | null
  finalNetWorth: number
  peakNetWorth: number
}
