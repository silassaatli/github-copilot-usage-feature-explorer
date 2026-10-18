import assert from 'node:assert/strict'
import test from 'node:test'
import { calculateLicense } from '../server/services/licensing.ts'

test('business license calculates subscription and credit overage', () => {
  const result = calculateLicense({
    plan: 'business',
    seats: 10,
    expectedCreditsPerSeat: 2_000,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.monthlySubscriptionUsd, 190)
    assert.equal(result.value.includedMonthlyAiCredits, 19_000)
    assert.equal(result.value.additionalAiCredits, 1_000)
    assert.equal(result.value.estimatedAdditionalUsageUsd, 10)
    assert.equal(result.value.estimatedMonthlyTotalUsd, 200)
  }
})

test('enterprise asks for a negotiated seat price', () => {
  const result = calculateLicense({
    plan: 'enterprise',
    seats: 2,
    expectedCreditsPerSeat: 4_000,
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.monthlySubscriptionUsd, undefined)
    assert.equal(result.value.includedMonthlyAiCredits, 7_800)
    assert.equal(result.value.additionalAiCredits, 200)
  }
})

test('invalid seat counts are rejected', () => {
  const result = calculateLicense({
    plan: 'business',
    seats: 0,
    expectedCreditsPerSeat: 100,
  })
  assert.deepEqual(result, { ok: false, error: 'Kullanıcı sayısı 1 ile 100.000 arasında olmalıdır.' })
})
