// ═══════════════════════════════════════════════════════════
// electron/LLMHelper.ts — SPEED-OPTIMIZED VERSION
// Fixed: Invalid model, no timeout, no streaming, massive prompts
// ═══════════════════════════════════════════════════════════

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import fs from "fs"

// ── Configuration Constants ──────────────────────────
const REQUEST_TIMEOUT_MS = 30000  // 30 second timeout
const MAX_RECOVERY_ATTEMPTS = 3
const CACHE_MAX_SIZE = 50

// ── Valid Gemini Models (2026) — ordered by speed ────
const VALID_MODELS = [
  "gemini-2.0-flash",       // ⚡ Fastest, best for real-time
  "gemini-2.0-flash-lite",  // ⚡ Very fast, lightweight
  "gemini-1.5-flash",       // ✅ Reliable fallback
  "gemini-1.5-flash-8b",    // ✅ Lightweight fallback
]

// ── Simple in-memory cache ───────────────────────────
class ResponseCache {
  private cache = new Map<string, { response: any; timestamp: number }>()
  private maxSize: number

  constructor(maxSize: number = CACHE_MAX_SIZE) {
    this.maxSize = maxSize
  }

  get(key: string): any | null {
    const entry = this.cache.get(key)
    if (!entry) return null

    // Cache valid for 5 minutes
    if (Date.now() - entry.timestamp > 5 * 60 * 1000) {
      this.cache.delete(key)
      return null
    }
    return entry.response
  }

  set(key: string, response: any): void {
    if (this.cache.size >= this.maxSize) {
      // Remove oldest entry
      const oldestKey = this.cache.keys().next().value
      if (oldestKey) this.cache.delete(oldestKey)
    }
    this.cache.set(key, { response, timestamp: Date.now() })
  }

  clear(): void {
    this.cache.clear()
  }
}

// ── Simplified System Prompt (~400 tokens vs 1000+) ──
const SYSTEM_PROMPT = `You are an interview assistant. Provide clear, accurate answers in 5-6 bullet points starting with '•'. Use simple English words. Each point should be 25-30 words. Total response: 150-180 words. Be specific, technical, and actionable. No introductory text.

Format:
• [Topic]: Detailed explanation in simple words (~30 words)
• [Topic]: Detailed explanation in simple words (~30 words)
• [Topic]: Detailed explanation in simple words (~30 words)
• [Topic]: Detailed explanation in simple words (~30 words)
• [Topic]: Detailed explanation in simple words (~30 words)
• [Pro Tip]: High-impact advice (~25 words)`

// ═══════════════════════════════════════════════════════════
// LLMHelper Class
// ═══════════════════════════════════════════════════════════

interface OllamaResponse {
  response: string
  done: boolean
}

export class LLMHelper {
  private model: GenerativeModel | null = null
  private genAI: GoogleGenerativeAI | null = null
  private apiKey: string = ""
  private geminiModelName: string = "gemini-2.0-flash" // ✅ VALID & FASTEST
  private isRecovering: boolean = false
  private readonly systemPrompt = SYSTEM_PROMPT
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"
  private cache: ResponseCache = new ResponseCache()

  constructor(
    apiKey?: string,
    useOllama: boolean = false,
    ollamaModel?: string,
    ollamaUrl?: string
  ) {
    this.useOllama = useOllama

    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest"
      console.log(`[LLMHelper] Using Ollama: ${this.ollamaModel}`)
      this.initializeOllamaModel()
    } else if (apiKey) {
      this.apiKey = apiKey
      this.genAI = new GoogleGenerativeAI(apiKey)
      this.geminiModelName = process.env.GEMINI_MODEL || "gemini-2.0-flash" // ✅ FAST
      this.model = this.genAI.getGenerativeModel({
        model: this.geminiModelName,
        generationConfig: {
          maxOutputTokens: 500,  // Reduced from 600
          temperature: 0.3
        }
      })
      console.log(`[LLMHelper] ✅ Initialized: ${this.geminiModelName}`)
    } else {
      throw new Error(
        "GEMINI_API_KEY not found. Set it in .env or enable Ollama with USE_OLLAMA=true"
      )
    }
  }

  // ── Timeout wrapper for API calls ─────────────────
  private withTimeout<T>(promise: Promise<T>, ms: number = REQUEST_TIMEOUT_MS): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`Request timeout (${ms / 1000}s)`)), ms)
      )
    ])
  }

  // ── Generate cache key from prompt ────────────────
  private getCacheKey(prompt: string): string {
    // Simple hash for cache key
    let hash = 0
    for (let i = 0; i < prompt.length; i++) {
      const char = prompt.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return `cache_${Math.abs(hash)}`
  }

  // ── Auto-recovery with VALID models only ──────────
  private async recoverWorkingGeminiModel(): Promise<GenerativeModel> {
    if (!this.genAI || !this.apiKey) {
      throw new Error("Cannot initialize Gemini without valid API key")
    }

    if (this.isRecovering && this.model) {
      return this.model
    }
    this.isRecovering = true
    console.log("[LLMHelper] Searching for working model...")

    for (const candidate of VALID_MODELS) {
      if (candidate === this.geminiModelName) continue

      try {
        console.log(`[LLMHelper] Testing '${candidate}'...`)
        const testModel = this.genAI.getGenerativeModel({
          model: candidate,
          generationConfig: { maxOutputTokens: 100, temperature: 0.1 }
        })

        // Quick test with timeout
        const result = await this.withTimeout(
          testModel.generateContent("Say 'ok'"),
          10000 // 10 sec test timeout
        )
        const response = await result.response

        if (response.text()) {
          this.geminiModelName = candidate
          this.model = this.genAI.getGenerativeModel({
            model: candidate,
            generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
          })
          this.isRecovering = false
          console.log(`[LLMHelper] ✅ Recovered: ${this.geminiModelName}`)
          return this.model
        }
      } catch (error: any) {
        const msg = error?.message || String(error)
        console.warn(`[LLMHelper] '${candidate}' failed: ${msg.substring(0, 60)}`)

        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
          this.isRecovering = false
          throw new Error("⚠️ Rate limit hit. Wait 30 seconds and try again.")
        }
      }
    }

    this.isRecovering = false
    throw new Error("⚠️ No working Gemini model found. Check API key and internet.")
  }

  // ── Get valid model (lazy init) ──────────────────
  private async getValidGeminiModel(): Promise<GenerativeModel> {
    if (this.model) return this.model

    if (!this.genAI || !this.apiKey) {
      throw new Error("Gemini not configured")
    }

    this.model = this.genAI.getGenerativeModel({
      model: this.geminiModelName,
      generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
    })
    return this.model
  }

  // ── Execute with auto-recovery + timeout ──────────
  private async executeWithAutoRecovery<T>(
    generateFn: (model: GenerativeModel) => Promise<T>
  ): Promise<T> {
    let model = await this.getValidGeminiModel()
    let lastError: any = null

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // ✅ Wrap in timeout
        return await this.withTimeout(generateFn(model), REQUEST_TIMEOUT_MS)
      } catch (error: any) {
        lastError = error
        const msg = error?.message || String(error)

        // Rate limit — throw immediately
        if (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
          throw new Error("⚠️ Rate limit hit. Wait 30 seconds.")
        }

        // Model not found — recover
        if (msg.includes("404") || msg.includes("not found")) {
          console.warn(`[LLMHelper] Model 404. Recovering...`)
          model = await this.recoverWorkingGeminiModel()
          return await this.withTimeout(generateFn(model), REQUEST_TIMEOUT_MS)
        }

        // Timeout — retry once
        if (msg.includes("timeout") && attempt < 2) {
          console.warn(`[LLMHelper] Timeout. Retrying...`)
          continue
        }

        // Network error — retry once
        if (
          (msg.includes("fetch failed") || msg.includes("network")) &&
          attempt < 2
        ) {
          console.warn(`[LLMHelper] Network error. Retrying...`)
          await new Promise((r) => setTimeout(r, 1000))
          continue
        }

        break
      }
    }

    const finalMsg = lastError?.message || String(lastError)
    if (finalMsg.includes("fetch failed") || finalMsg.includes("network")) {
      throw new Error("⚠️ Network error. Check internet connection.")
    }
    throw lastError
  }

  // ── File to generative part (for images) ──────────
  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  // ── Clean JSON response ───────────────────────────
  private cleanJsonResponse(text: string): string {
    text = text.replace(/^```(?:json)?\n/, "").replace(/\n```$/, "")
    return text.trim()
  }

  // ── Ollama API call ───────────────────────────────
  private async callOllama(prompt: string): Promise<string> {
    try {
      const response = await this.withTimeout(
        fetch(`${this.ollamaUrl}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: this.ollamaModel,
            prompt,
            stream: false,
            options: { temperature: 0.7, top_p: 0.9 }
          })
        }),
        60000 // Ollama gets 60s (local, can be slower)
      )

      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error: any) {
      throw new Error(
        `Ollama connection failed: ${error.message}. Is Ollama running?`
      )
    }
  }

  // ── Ollama helpers ────────────────────────────────
  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const models = await this.getOllamaModels()
      if (models.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }
      if (!models.includes(this.ollamaModel)) {
        this.ollamaModel = models[0]
        console.log(`[LLMHelper] Auto-selected: ${this.ollamaModel}`)
      }
    } catch (error: any) {
      console.error(`[LLMHelper] Ollama init failed: ${error.message}`)
    }
  }

  // ═══════════════════════════════════════════════════
  // PUBLIC METHODS
  // ═══════════════════════════════════════════════════

  // ── Extract problem from images ───────────────────
  public async extractProblemFromImages(imagePaths: string[]) {
    const cacheKey = this.getCacheKey(`extract_${imagePaths.join("_")}`)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      console.log("[LLMHelper] Cache hit for extractProblemFromImages")
      return cached
    }

    try {
      const imageParts = await Promise.all(
        imagePaths.map((p) => this.fileToGenerativePart(p))
      )

      const prompt = `${this.systemPrompt}\n\nAnalyze these images and extract the problem/topic in JSON:\n{"problem_statement": "...", "context": "...", "suggested_responses": ["• ...", "• ...", "• ...", "• ...", "• ..."]}\nReturn ONLY JSON.`

      const result = await this.executeWithAutoRecovery(async (model) => {
        const res = await model.generateContent([prompt, ...imageParts])
        const text = this.cleanJsonResponse(res.response.text())
        return JSON.parse(text)
      })

      this.cache.set(cacheKey, result)
      return result
    } catch (error) {
      console.error("Error extracting problem:", error)
      throw error
    }
  }

  // ── Generate solution ─────────────────────────────
  public async generateSolution(problemInfo: any) {
    const cacheKey = this.getCacheKey(`solution_${JSON.stringify(problemInfo).substring(0, 200)}`)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      console.log("[LLMHelper] Cache hit for generateSolution")
      return cached
    }

    const prompt = `${this.systemPrompt}\n\nTopic: ${JSON.stringify(problemInfo)}\n\nProvide solution in JSON:\n{"solution": {"code": "...", "problem_statement": "...", "suggested_responses": ["• ...", "• ...", "• ...", "• ...", "• ...", "• ..."]}}\nReturn ONLY JSON.`

    console.log("[LLMHelper] Generating solution...")
    try {
      const result = await this.executeWithAutoRecovery(async (model) => {
        const res = await model.generateContent(prompt)
        const text = this.cleanJsonResponse(res.response.text())
        return JSON.parse(text)
      })

      this.cache.set(cacheKey, result)
      console.log("[LLMHelper] ✅ Solution generated")
      return result
    } catch (error) {
      console.error("[LLMHelper] Solution error:", error)
      throw error
    }
  }

  // ── Debug solution with images ────────────────────
  public async debugSolutionWithImages(
    problemInfo: any,
    currentCode: string,
    debugImagePaths: string[]
  ) {
    try {
      const imageParts = await Promise.all(
        debugImagePaths.map((p) => this.fileToGenerativePart(p))
      )

      const prompt = `${this.systemPrompt}\n\nDebug this:\nTopic: ${JSON.stringify(problemInfo)}\nCode: ${currentCode}\n\nProvide fix in JSON:\n{"solution": {"code": "...", "problem_statement": "...", "suggested_responses": ["• Root cause: ...", "• Fix: ...", "• Performance: ...", "• Prevention: ...", "• Pro tip: ..."]}}\nReturn ONLY JSON.`

      return await this.executeWithAutoRecovery(async (model) => {
        const res = await model.generateContent([prompt, ...imageParts])
        const text = this.cleanJsonResponse(res.response.text())
        return JSON.parse(text)
      })
    } catch (error) {
      console.error("Debug error:", error)
      throw error
    }
  }

  // ── Analyze audio file ────────────────────────────
  public async analyzeAudioFile(audioPath: string) {
    try {
      const audioData = await fs.promises.readFile(audioPath)
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: audioPath.endsWith(".mp3") ? "audio/mp3" : "audio/wav"
        }
      }

      const prompt = `${this.systemPrompt}\n\nListen to this audio. Extract the question and answer in 5-6 bullet points (~150 words). Use simple English.\n\nFormat:\n❓ QUESTION: [summary]\n\n💡 ANSWER:\n• [point 1]\n• [point 2]\n• [point 3]\n• [point 4]\n• [point 5]\n• [Pro tip]`

      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }, audioPart] }],
          generationConfig: {
            maxOutputTokens: 450,
            temperature: 0.2,
            topK: 20
          }
        })
        const text = result.response.text().trim()
        return { text, timestamp: Date.now() }
      })
    } catch (error) {
      console.error("Audio analysis error:", error)
      throw error
    }
  }

  // ── Analyze audio from base64 ─────────────────────
  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      const audioPart = {
        inlineData: { data, mimeType }
      }

      const prompt = `${this.systemPrompt}\n\nListen to this audio. Extract the question and answer in 5-6 bullet points (~150 words). Use simple English.`

      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent({
          contents: [{ role: "user", parts: [{ text: prompt }, audioPart] }],
          generationConfig: {
            maxOutputTokens: 450,
            temperature: 0.2
          }
        })
        return { text: result.response.text().trim(), timestamp: Date.now() }
      })
    } catch (error) {
      console.error("Audio base64 error:", error)
      throw error
    }
  }

  // ── Analyze single image file ─────────────────────
  public async analyzeImageFile(imagePath: string) {
    try {
      const imageData = await fs.promises.readFile(imagePath)
      const imagePart = {
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png"
        }
      }

      const prompt = `${this.systemPrompt}\n\nAnalyze this screenshot. Answer in 5-6 bullet points (~150 words). Simple English.`

      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent([prompt, imagePart])
        return { text: result.response.text().trim(), timestamp: Date.now() }
      })
    } catch (error) {
      console.error("Image analysis error:", error)
      throw error
    }
  }

  // ── Chat (text question) ──────────────────────────
  public async chatWithGemini(message: string): Promise<string> {
    // Check cache first
    const cacheKey = this.getCacheKey(`chat_${message}`)
    const cached = this.cache.get(cacheKey)
    if (cached) {
      console.log("[LLMHelper] Cache hit for chat")
      return cached
    }

    try {
      if (this.useOllama) {
        return await this.callOllama(
          `${this.systemPrompt}\n\nQuestion: "${message}"\n\nAnswer in 5-6 bullet points.`
        )
      }

      const result = await this.executeWithAutoRecovery(async (model) => {
        const prompt = `${this.systemPrompt}\n\nQuestion: "${message}"\n\nAnswer in 5-6 bullet points (~150 words). Simple English.`
        const res = await model.generateContent(prompt)
        return res.response.text().trim()
      })

      this.cache.set(cacheKey, result)
      return result
    } catch (error) {
      console.error("[LLMHelper] Chat error:", error)
      throw error
    }
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGemini(message)
  }

  // ── Provider info ─────────────────────────────────
  public isUsingOllama(): boolean {
    return this.useOllama
  }

  public getCurrentProvider(): "ollama" | "gemini" {
    return this.useOllama ? "ollama" : "gemini"
  }

  public getCurrentModel(): string {
    return this.useOllama ? this.ollamaModel : this.geminiModelName
  }

  public async getOllamaModels(): Promise<string[]> {
    if (!this.useOllama) return []
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      if (!response.ok) throw new Error("Failed to fetch models")
      const data = await response.json()
      return data.models?.map((m: any) => m.name) || []
    } catch {
      return []
    }
  }

  // ── Switch providers ──────────────────────────────
  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true
    if (url) this.ollamaUrl = url
    if (model) {
      this.ollamaModel = model
    } else {
      await this.initializeOllamaModel()
    }
    console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel}`)
  }

  public async switchToGemini(apiKey?: string): Promise<void> {
    if (apiKey) this.apiKey = apiKey
    if (!this.apiKey) throw new Error("No Gemini API key")

    this.genAI = new GoogleGenerativeAI(this.apiKey)
    this.geminiModelName = "gemini-2.0-flash"
    this.model = this.genAI.getGenerativeModel({
      model: this.geminiModelName,
      generationConfig: { maxOutputTokens: 500, temperature: 0.3 }
    })
    this.useOllama = false
    console.log(`[LLMHelper] Switched to Gemini: ${this.geminiModelName}`)
  }

  // ── Connection test ───────────────────────────────
  public async testConnection(): Promise<{
    success: boolean
    error?: string
    latencyMs?: number
  }> {
    const start = Date.now()
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable()
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` }
        }
        await this.callOllama("Hello")
        return { success: true, latencyMs: Date.now() - start }
      } else {
        const model = await this.getValidGeminiModel()
        const result = await this.withTimeout(
          model.generateContent("Say ok"),
          15000
        )
        const response = await result.response
        if (response.text()) {
          return { success: true, latencyMs: Date.now() - start }
        }
        return { success: false, error: "Empty response" }
      }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  }

  // ── Clear cache ───────────────────────────────────
  public clearCache(): void {
    this.cache.clear()
    console.log("[LLMHelper] Cache cleared")
  }
}
