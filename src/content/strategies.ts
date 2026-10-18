import type { Strategy } from '../types'

export const strategies: Array<{ id: Strategy; title: string; hint: string }> = [
  { id: 'normal', title: 'Normal oturum', hint: 'Standart Copilot sohbeti; dosya ve terminal araçları kapalıdır.' },
  { id: 'skill', title: 'Skill kullan', hint: 'Yerel, salt okunur kod inceleme Skill’i (yeniden kullanılabilir yönerge) etkinleştirilir.' },
  { id: 'subagents', title: 'Alt ajanlarla analiz', hint: 'Araçsız, salt okunur üç uzman alt ajan (subagent) tanımlanır.' },
  { id: 'fleet', title: 'Fleet · deneysel', hint: 'Bağımsız işleri paralel koordine eder; ek ajan çağrıları AI Credit tüketimini artırabilir.' },
]

export function strategyLabel(strategy: string) {
  return strategies.find((item) => item.id === strategy)?.title ?? strategy
}
