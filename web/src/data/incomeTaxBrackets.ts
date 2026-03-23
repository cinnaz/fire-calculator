export const DEFAULT_INCOME_TAX_BRACKET_ID = 'ca-200k-to-500k'

export const incomeTaxBrackets = [
  {
    id: 'ca-up-to-200k',
    label: 'Up to $200k',
    totalTaxRate: 0.352,
    sourceLabel: 'California total tax reference',
    sourceUrl: 'https://www.talent.com/tax-calculator?salary=400000&from=year&region=California',
  },
  {
    id: 'ca-200k-to-500k',
    label: '$200k to $500k',
    totalTaxRate: 0.431,
    sourceLabel: 'California total tax reference',
    sourceUrl: 'https://www.talent.com/tax-calculator?salary=400000&from=year&region=California',
  },
  {
    id: 'ca-over-800k',
    label: 'Over $500k',
    totalTaxRate: 0.47,
    sourceLabel: 'California total tax reference',
    sourceUrl: 'https://www.talent.com/tax-calculator?salary=400000&from=year&region=California',
  },
] as const
