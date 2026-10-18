import assert from 'node:assert/strict'
import test from 'node:test'
import { filterSelectableModels, getSelectableAutoTiers } from '../server/services/model-catalog.ts'

test('only exposes unique models allowed by the session catalog', () => {
  const models = [
    { id: 'auto', name: 'Auto' },
    { id: 'auto', name: 'Auto duplicate' },
    { id: 'gpt-example', name: 'Example' },
  ]

  assert.deepEqual(filterSelectableModels(models, new Set(['auto'])), [
    { id: 'auto', name: 'Auto' },
  ])
})

test('exposes only runtime-enabled Auto tiers with Turkish labels', () => {
  const tiers = getSelectableAutoTiers({
    tiers: [
      { id: 'efficiency', displayName: 'Efficiency', description: '', type: 'auto', status: { enabled: true } },
      { id: 'balance', displayName: 'Balance', description: '', type: 'auto', status: { enabled: false } },
      { id: 'intelligence', displayName: 'Intelligence', description: '', type: 'auto', status: { enabled: true } },
      { id: 'fast', displayName: 'Fast', description: '', type: 'auto', status: { enabled: true } },
      { id: 'future-tier', displayName: 'Future', description: '', type: 'auto', status: { enabled: true } },
      { id: 'other', displayName: 'Other', description: '', type: 'named-model', status: { enabled: true } },
    ],
  })

  assert.deepEqual(tiers, [
    { id: 'efficiency', label: 'Verimlilik' },
    { id: 'intelligence', label: 'Zekâ' },
    { id: 'fast', label: 'Hızlı' },
  ])
})

test('an unreported Auto tier catalog exposes no tiers', () => {
  assert.deepEqual(getSelectableAutoTiers(undefined), [])
})
