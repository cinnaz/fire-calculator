import { describe, expect, it } from 'vitest'
import { scenarioPresets } from '../data/scenarioPresets'
import {
  calculateAnnualMortgage,
  deriveHousingItems,
  simulateScenario,
} from './simulate'

describe('simulateScenario', () => {
  it('matches the first years of the house + public school spreadsheet projection', () => {
    const result = simulateScenario(scenarioPresets[0])

    expect(result.yearlyRows[0].expenses).toBeCloseTo(174000, 3)
    expect(result.yearlyRows[0].income).toBeCloseTo(430180, 3)
    expect(result.yearlyRows[0].investmentGrowth).toBeCloseTo(147730.016, 3)
    expect(result.yearlyRows[0].closingNetWorth).toBeCloseTo(4097160.416, 3)

    expect(result.yearlyRows[1].closingNetWorth).toBeCloseTo(4380226.833, 3)
    expect(result.yearlyRows[2].closingNetWorth).toBeCloseTo(4174435.906, 3)
  })

  it('matches the early years of the house + private school spreadsheet projection', () => {
    const result = simulateScenario(scenarioPresets[2])

    expect(result.yearlyRows[0].closingNetWorth).toBeCloseTo(5302135.52, 3)
    expect(result.yearlyRows[1].closingNetWorth).toBeCloseTo(5963830.941, 3)
    expect(result.yearlyRows[2].closingNetWorth).toBeCloseTo(6373144.178, 3)
  })
})

describe('deriveHousingItems', () => {
  it('recreates the spreadsheet housing events for the house + public school preset', () => {
    const housing = scenarioPresets[0].housing
    const annualMortgage = calculateAnnualMortgage(housing)
    const items = deriveHousingItems(housing)

    expect(annualMortgage).toBeCloseTo(143892.126, 3)
    expect(items.find((item) => item.label === 'Down Payment')?.amount).toBe(
      500000,
    )
    expect(items.find((item) => item.label === 'Closing costs')?.amount).toBe(
      100000,
    )
    expect(items.find((item) => item.label === 'Property tax cost')?.amount).toBe(
      50000,
    )
    expect(items.find((item) => item.label === 'Sell the house')?.amount).toBe(
      1875000,
    )
  })
})
