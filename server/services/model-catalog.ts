export interface RuntimeAutoTier {
  id: string
  displayName: string
  description: string
  type: string
  status: {
    enabled: boolean
  }
}

export interface AutoTierChoice {
  id: string
  label: string
}

const autoTierLabels: Record<string, string> = {
  efficiency: 'Verimlilik',
  balance: 'Dengeli',
  intelligence: 'Zekâ',
  fast: 'Hızlı',
}

export function getSelectableAutoTiers(
  metadata: { tiers: RuntimeAutoTier[] } | undefined,
): AutoTierChoice[] {
  if (!metadata) return []

  return metadata.tiers.flatMap((tier) => {
    const label = autoTierLabels[tier.id]
    return tier.type === 'auto' && tier.status.enabled && label
      ? [{ id: tier.id, label }]
      : []
  })
}

export function filterSelectableModels<T extends { id: string }>(
  models: T[],
  sessionModelIds?: ReadonlySet<string>,
): T[] {
  const seen = new Set<string>()
  return models.filter((model) => {
    if (seen.has(model.id) || (sessionModelIds && !sessionModelIds.has(model.id))) {
      return false
    }
    seen.add(model.id)
    return true
  })
}
