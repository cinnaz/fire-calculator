export type TaxRateLookupResult = {
  averageTaxRate: number
  sourceUrl: string
}

export const fetchAverageTaxRate = async (
  householdIncome: number,
  workState: string,
): Promise<TaxRateLookupResult> => {
  const params = new URLSearchParams({
    income: String(Math.round(householdIncome)),
    state: workState,
  })

  const response = await fetch(`/api/tax-rate?${params.toString()}`)

  if (!response.ok) {
    throw new Error('Unable to retrieve tax rate from Talent.com right now.')
  }

  const payload = (await response.json()) as Partial<TaxRateLookupResult> & {
    error?: string
  }

  if (
    typeof payload.averageTaxRate !== 'number' ||
    !Number.isFinite(payload.averageTaxRate) ||
    typeof payload.sourceUrl !== 'string'
  ) {
    throw new Error(payload.error ?? 'The tax rate response was incomplete.')
  }

  return {
    averageTaxRate: payload.averageTaxRate,
    sourceUrl: payload.sourceUrl,
  }
}
