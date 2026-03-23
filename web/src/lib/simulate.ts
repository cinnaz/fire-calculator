import type {
  CashFlowItem,
  HousingPlan,
  Scenario,
  SimulationResult,
  YearlyProjection,
} from '../types'
import {
  DEFAULT_INCOME_TAX_BRACKET_ID,
  incomeTaxBrackets,
} from '../data/incomeTaxBrackets'

const roundTo = (value: number, digits = 4) => {
  const factor = 10 ** digits
  return Math.round((value + Number.EPSILON) * factor) / factor
}

export const calculatePostTaxIncome = (
  preTaxAmount: number | null,
  incomeTaxRate: number,
) => {
  if (preTaxAmount === null) {
    return null
  }

  return roundTo(preTaxAmount * (1 - incomeTaxRate))
}

export const resolveCashFlowAmount = (
  item: CashFlowItem,
  incomeTaxRate: number,
) => {
  if (item.kind === 'income' && item.preTaxAmount !== null) {
    return calculatePostTaxIncome(item.preTaxAmount, incomeTaxRate)
  }

  return item.amount
}

export const calculateAnnualMortgage = (housing: HousingPlan) => {
  const homePrice = housing.homePrice ?? 0

  if (!housing.enabled || homePrice <= 0) {
    return 0
  }

  const principal = homePrice * (1 - housing.downPaymentRate)
  const monthlyRate = housing.annualInterestRate / 12
  const payments = housing.mortgageTermYears * 12

  if (principal <= 0 || payments <= 0) {
    return 0
  }

  if (monthlyRate === 0) {
    return principal / housing.mortgageTermYears
  }

  const monthlyPayment =
    (principal * (monthlyRate * (1 + monthlyRate) ** payments)) /
    ((1 + monthlyRate) ** payments - 1)

  return monthlyPayment * 12
}

export const deriveHousingItems = (housing: HousingPlan): CashFlowItem[] => {
  const homePrice = housing.homePrice ?? 0

  if (!housing.enabled || homePrice <= 0) {
    return []
  }

  const annualMortgage = calculateAnnualMortgage(housing)
  const downPayment = homePrice * housing.downPaymentRate
  const closingCosts = homePrice * housing.closingCostRate
  const propertyTax = homePrice * housing.propertyTaxRate
  const mortgageEndYear = housing.saleYear ?? housing.mortgageEndYear
  const propertyTaxEndYear = housing.saleYear ?? housing.propertyTaxEndYear

  const items: CashFlowItem[] = [
    {
      id: 'housing-mortgage',
      kind: 'expense',
      label: 'Yearly Mortgage',
      preTaxAmount: null,
      amount: annualMortgage,
      startYear: housing.purchaseYear,
      endYear: mortgageEndYear,
    },
    {
      id: 'housing-down-payment',
      kind: 'expense',
      label: 'Down Payment',
      preTaxAmount: null,
      amount: downPayment,
      startYear: housing.purchaseYear,
      endYear: housing.purchaseYear,
    },
    {
      id: 'housing-closing-costs',
      kind: 'expense',
      label: 'Closing costs',
      preTaxAmount: null,
      amount: closingCosts,
      startYear: housing.purchaseYear,
      endYear: housing.purchaseYear,
    },
    {
      id: 'housing-property-tax',
      kind: 'expense',
      label: 'Property tax cost',
      preTaxAmount: null,
      amount: propertyTax,
      startYear: housing.purchaseYear,
      endYear: propertyTaxEndYear,
    },
  ]

  if (housing.saleYear !== null) {
    items.push({
      id: 'housing-sale',
      kind: 'income',
      label: 'Sell the house',
      preTaxAmount: null,
      amount: homePrice * (1 + housing.saleAppreciationRate) * housing.saleOwnershipShare,
      startYear: housing.saleYear,
      endYear: housing.saleYear,
    })
  }

  return items.filter(
    (item) => item.amount !== null && Number.isFinite(item.amount) && item.amount !== 0,
  )
}

export const collectAllCashFlowItems = (scenario: Scenario) => [
  ...deriveHousingItems(scenario.housing),
  ...scenario.cashFlowItems.filter(
    (item) =>
      (item.amount !== null || item.preTaxAmount !== null) &&
      (item.amount === null || Number.isFinite(item.amount)) &&
      (item.preTaxAmount === null || Number.isFinite(item.preTaxAmount)) &&
      item.label.trim().length > 0,
  ),
]

export const simulateScenario = (scenario: Scenario): SimulationResult => {
  const allCashFlowItems = collectAllCashFlowItems(scenario)
  const yearlyRows: YearlyProjection[] = []
  let openingNetWorth = scenario.currentNetWorth ?? 0
  let retirementYear: number | null = null
  const incomeTaxRate =
    incomeTaxBrackets.find(
      (bracket) => bracket.id === scenario.incomeTaxBracketId,
    )?.totalTaxRate ?? incomeTaxBrackets.find((bracket) => bracket.id === DEFAULT_INCOME_TAX_BRACKET_ID)?.totalTaxRate ?? 0

  for (let year = scenario.startYear; year <= scenario.endYear; year += 1) {
    const expenses = roundTo(
      allCashFlowItems
        .filter(
          (item) =>
            item.kind === 'expense' &&
            item.startYear <= year &&
            item.endYear >= year,
        )
        .reduce((total, item) => total + (resolveCashFlowAmount(item, incomeTaxRate) ?? 0), 0),
    )

    const income = roundTo(
      allCashFlowItems
        .filter(
          (item) =>
            item.kind === 'income' &&
            item.startYear <= year &&
            item.endYear >= year,
        )
        .reduce((total, item) => total + (resolveCashFlowAmount(item, incomeTaxRate) ?? 0), 0),
    )

    const investmentGrowth = roundTo(
      openingNetWorth * scenario.investmentReturnRate,
    )
    const closingNetWorth = roundTo(
      openingNetWorth + income + investmentGrowth - expenses,
    )
    const goalReached =
      scenario.goalNetWorth !== null && closingNetWorth >= scenario.goalNetWorth

    if (goalReached && retirementYear === null) {
      retirementYear = year
    }

    yearlyRows.push({
      year,
      openingNetWorth: roundTo(openingNetWorth),
      expenses,
      income,
      investmentGrowth,
      closingNetWorth,
      goalReached,
    })

    openingNetWorth = closingNetWorth
  }

  const finalNetWorth = yearlyRows.at(-1)?.closingNetWorth ?? (scenario.currentNetWorth ?? 0)
  const peakNetWorth = yearlyRows.reduce(
    (highest, row) => Math.max(highest, row.closingNetWorth),
    scenario.currentNetWorth ?? 0,
  )

  return {
    allCashFlowItems,
    yearlyRows,
    retirementYear,
    finalNetWorth,
    peakNetWorth,
  }
}
