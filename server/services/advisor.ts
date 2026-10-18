export interface AdvisorAnswers {
  task: string
  needsFileChanges?: boolean
  needsTerminal?: boolean
  multipleDomains?: boolean
  parallelizable?: boolean
  sequentialDependencies?: boolean
  reusableInstructions?: boolean
  externalService?: boolean
  deterministicChecks?: boolean
  complexity?: 'small' | 'medium' | 'large'
}

export interface Recommendation {
  primary: string
  supporting: string[]
  explanation: string
  costCategory: 'düşük' | 'orta' | 'yüksek'
  whyNotMore: string
  warnings: string[]
}

export function getRecommendation(
  input: Record<string, unknown>,
): Recommendation {
  const answers: AdvisorAnswers = {
    task: typeof input.task === 'string' ? input.task : '',
    needsFileChanges: input.needsFileChanges === true,
    needsTerminal: input.needsTerminal === true,
    multipleDomains: input.multipleDomains === true,
    parallelizable: input.parallelizable === true,
    sequentialDependencies: input.sequentialDependencies === true,
    reusableInstructions: input.reusableInstructions === true,
    externalService: input.externalService === true,
    deterministicChecks: input.deterministicChecks === true,
    complexity:
      input.complexity === 'small' ||
      input.complexity === 'large' ||
      input.complexity === 'medium'
        ? input.complexity
        : 'small',
  }
  const supporting: string[] = []
  const warnings: string[] = []
  let primary = 'Basit Sohbet'
  let costCategory: Recommendation['costCategory'] = 'düşük'

  if (
    answers.complexity === 'large' &&
    answers.multipleDomains &&
    answers.parallelizable &&
    !answers.sequentialDependencies
  ) {
    primary = 'Fleet / Orkestrasyon'
    supporting.push('Ajan', 'Alt ajan')
    costCategory = 'yüksek'
  } else if (answers.needsFileChanges || answers.needsTerminal) {
    primary =
      answers.externalService
        ? 'Ajan + MCP'
        : answers.reusableInstructions
          ? 'Ajan + Skill'
          : answers.multipleDomains &&
              answers.complexity !== 'small' &&
              !answers.sequentialDependencies
            ? 'Ajan + Alt ajan'
            : 'Ajan'
    costCategory = answers.complexity === 'large' ? 'yüksek' : 'orta'
    if (answers.multipleDomains) supporting.push('Alt ajan')
  }

  if (answers.reusableInstructions && !primary.includes('Skill')) supporting.push('Skill')
  if (answers.externalService && !primary.includes('MCP')) supporting.push('MCP')
  if (answers.deterministicChecks) supporting.push('Hook')

  if (answers.sequentialDependencies && answers.parallelizable) {
    warnings.push('Alt görevler sıralı bağımlılıklar içeriyor; paralel yürütme uygun olmayabilir.')
  }
  if (answers.complexity === 'small' && answers.multipleDomains) {
    warnings.push('Küçük bir görev için çoklu ajan yapısı gereksiz ek kullanım yaratabilir.')
  }
  if (primary === 'Fleet / Orkestrasyon' && answers.sequentialDependencies) {
    primary = 'Ajan'
  }

  return {
    primary,
    supporting: [...new Set(supporting)],
    explanation:
      primary === 'Basit Sohbet'
        ? 'Görev açıklama veya sınırlı bir soru niteliğinde; araç kullanan bir akış gerekmiyor.'
        : primary === 'Fleet / Orkestrasyon'
          ? 'Birbirinden bağımsız, farklı alanlara ayrılabilen büyük işler paralel yürütmeye elverişli.'
          : 'Dosya veya araç gerektiren çok adımlı görev için Ajan daha uygun.',
    costCategory,
    whyNotMore:
      primary === 'Basit Sohbet'
        ? 'Dosya, terminal veya bağımsız iş akışı gereksinimi belirtilmedi.'
        : primary === 'Ajan'
          ? 'Bağımsız ve paralel büyük iş akışları gösterilmediği için Fleet önerilmiyor.'
          : 'Daha küçük veya sıralı işlerde Fleet gereksiz paralellik ve ek kullanım yaratır.',
    warnings,
  }
}
