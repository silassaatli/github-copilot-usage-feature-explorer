import { copilotPlans, pricingMetadata, type PlanId } from '../data/copilot-plans.js'

type CalculationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

export function calculateLicense(body: unknown): CalculationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'Hesaplama bilgileri geçersiz.' }
  }
  const values = body as Record<string, unknown>
  const plan = copilotPlans.find((item) => item.id === values.plan)
  if (!plan) return { ok: false, error: 'Lütfen geçerli bir plan seçin.' }
  const seats = values.seats
  const expectedCredits = values.expectedCreditsPerSeat
  const includedCredits = values.includedCreditsPerSeat
  const enterprisePrice = values.enterpriseSeatPriceUsd
  if (!Number.isInteger(seats) || Number(seats) < 1 || Number(seats) > 100_000) {
    return { ok: false, error: 'Kullanıcı sayısı 1 ile 100.000 arasında olmalıdır.' }
  }
  if (
    typeof expectedCredits !== 'number' ||
    !Number.isFinite(expectedCredits) ||
    expectedCredits < 0
  ) {
    return { ok: false, error: 'Beklenen AI Credit miktarı sıfır veya daha büyük olmalıdır.' }
  }
  if (
    includedCredits !== undefined &&
    (typeof includedCredits !== 'number' ||
      !Number.isFinite(includedCredits) ||
      includedCredits < 0)
  ) {
    return { ok: false, error: 'Dahil edilen AI Credit miktarı geçersiz.' }
  }
  if (
    enterprisePrice !== undefined &&
    (typeof enterprisePrice !== 'number' ||
      !Number.isFinite(enterprisePrice) ||
      enterprisePrice < 0)
  ) {
    return { ok: false, error: 'Koltuk başına fiyat geçersiz.' }
  }

  const seatCount = Number(seats)
  const seatPrice =
    plan.monthlySeatPriceUsd ?? (typeof enterprisePrice === 'number' ? enterprisePrice : undefined)
  const monthlySubscriptionUsd =
    seatPrice === undefined ? undefined : seatCount * seatPrice
  const totalIncludedCredits =
    typeof includedCredits === 'number'
      ? seatCount * includedCredits
      : seatCount * plan.includedAiCreditsPerSeat
  const expectedMonthlyCredits = seatCount * expectedCredits
  const additionalCredits =
    totalIncludedCredits === undefined
      ? undefined
      : Math.max(0, expectedMonthlyCredits - totalIncludedCredits)
  const additionalUsageUsd =
    additionalCredits === undefined
      ? undefined
      : additionalCredits * pricingMetadata.aiCreditUsd

  return {
    ok: true,
    value: {
      plan: plan.name,
      seats: seatCount,
      monthlySeatPriceUsd: seatPrice,
      monthlySubscriptionUsd,
        annualSubscriptionUsd:
          monthlySubscriptionUsd === undefined ? undefined : monthlySubscriptionUsd * 12,
      includedMonthlyAiCredits: totalIncludedCredits,
      expectedMonthlyAiCredits: expectedMonthlyCredits,
      additionalAiCredits: additionalCredits,
      estimatedAdditionalUsageUsd: additionalUsageUsd,
      estimatedMonthlyTotalUsd:
        additionalUsageUsd === undefined || monthlySubscriptionUsd === undefined
          ? undefined
          : monthlySubscriptionUsd + additionalUsageUsd,
      perSeatMonthlyAverageUsd:
        additionalUsageUsd === undefined || monthlySubscriptionUsd === undefined
          ? undefined
          : (monthlySubscriptionUsd + additionalUsageUsd) / seatCount,
      aiCreditUsd: pricingMetadata.aiCreditUsd,
      includedCreditsNote:
        typeof includedCredits === 'number'
          ? 'Dahil edilen kredi miktarı kullanıcı tarafından girildi.'
          : pricingMetadata.includedCreditsNote,
      pricing: pricingMetadata,
    },
  }
}

export function isPlanId(value: unknown): value is PlanId {
  return copilotPlans.some((plan) => plan.id === value)
}
