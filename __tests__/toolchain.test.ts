import { describe, it, expect } from 'vitest'

describe('toolchain', () => {
  it('compiles TypeScript strict mode and runs vitest', () => {
    const x: number = 41 + 1
    expect(x).toBe(42)
  })
})
