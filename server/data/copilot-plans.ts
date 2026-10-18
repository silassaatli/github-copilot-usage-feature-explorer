export type PlanId = 'pro' | 'pro-plus' | 'max' | 'business' | 'enterprise'

export interface CopilotPlan {
  id: PlanId
  name: string
  accountType: 'individual' | 'organization'
  monthlySeatPriceUsd: number | null
  includedAiCreditsPerSeat: number
  baseAiCreditsPerSeat?: number
  flexAiCreditsPerSeat?: number
}

export const pricingMetadata = {
  sources: [
    'https://docs.github.com/en/copilot/concepts/billing-and-usage/individuals/billing',
    'https://docs.github.com/en/copilot/concepts/billing-and-usage/organizations-and-enterprises/billing',
    'https://docs.github.com/en/billing/concepts/product-billing/github-copilot-licenses',
  ],
  lastVerified: '2026-10-15',
  aiCreditUsd: 0.01,
  includedCreditsNote:
    'Bireysel planlar base + flex kredi toplamını; kuruluş planları kullanıcı başına aylık kredi tahsisatını kullanır.',
}

export const copilotPlans: CopilotPlan[] = [
  { id: 'pro', name: 'Copilot Pro', accountType: 'individual', monthlySeatPriceUsd: 10, includedAiCreditsPerSeat: 1_500, baseAiCreditsPerSeat: 1_000, flexAiCreditsPerSeat: 500 },
  { id: 'pro-plus', name: 'Copilot Pro+', accountType: 'individual', monthlySeatPriceUsd: 39, includedAiCreditsPerSeat: 7_000, baseAiCreditsPerSeat: 3_900, flexAiCreditsPerSeat: 3_100 },
  { id: 'max', name: 'Copilot Max', accountType: 'individual', monthlySeatPriceUsd: 100, includedAiCreditsPerSeat: 20_000, baseAiCreditsPerSeat: 10_000, flexAiCreditsPerSeat: 10_000 },
  { id: 'business', name: 'Copilot Business', accountType: 'organization', monthlySeatPriceUsd: 19, includedAiCreditsPerSeat: 1_900 },
  { id: 'enterprise', name: 'Copilot Enterprise', accountType: 'organization', monthlySeatPriceUsd: null, includedAiCreditsPerSeat: 3_900 },
]
