import assert from 'node:assert/strict'
import test from 'node:test'
import { getRecommendation } from '../server/services/advisor.ts'

test('simple questions recommend chat and no extra capabilities', () => {
  const result = getRecommendation({ task: 'Explain a short function' })
  assert.equal(result.primary, 'Basit Sohbet')
  assert.equal(result.costCategory, 'düşük')
  assert.deepEqual(result.supporting, [])
})

test('file and terminal work recommends an agent', () => {
  const result = getRecommendation({
    task: 'Implement and test the change',
    needsFileChanges: true,
    needsTerminal: true,
    complexity: 'medium',
  })
  assert.equal(result.primary, 'Ajan')
  assert.equal(result.costCategory, 'orta')
})

test('large independent work recommends fleet', () => {
  const result = getRecommendation({
    task: 'Coordinate independent workstreams',
    needsFileChanges: true,
    multipleDomains: true,
    parallelizable: true,
    complexity: 'large',
  })
  assert.equal(result.primary, 'Fleet / Orkestrasyon')
  assert.ok(result.supporting.includes('Alt ajan'))
})

test('reusable domain instructions support an agent with a skill', () => {
  const result = getRecommendation({
    task: 'Implement with the reusable domain workflow',
    needsFileChanges: true,
    reusableInstructions: true,
    complexity: 'medium',
  })
  assert.equal(result.primary, 'Ajan + Skill')
})

test('external service requirements recommend an agent with MCP', () => {
  const result = getRecommendation({
    task: 'Query an external tracker and update the issue',
    needsFileChanges: true,
    externalService: true,
    complexity: 'medium',
  })
  assert.equal(result.primary, 'Ajan + MCP')
})

test('sequential dependencies prevent a fleet recommendation', () => {
  const result = getRecommendation({
    task: 'Implement a dependent migration and API update',
    needsFileChanges: true,
    multipleDomains: true,
    parallelizable: true,
    sequentialDependencies: true,
    complexity: 'large',
  })
  assert.equal(result.primary, 'Ajan')
  assert.ok(result.warnings.length > 0)
})
