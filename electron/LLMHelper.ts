import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import fs from "fs"
import dns from "node:dns"

try {
  dns.setDefaultResultOrder("ipv4first");
} catch (e) {
}
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

interface OllamaResponse {
  response: string
  done: boolean
}

export class LLMHelper {
  private model: GenerativeModel | null = null
  private genAI: GoogleGenerativeAI | null = null
  private apiKey: string = ""
  private geminiModelName: string = "gemini-flash-lite-latest"
  private isRecovering: boolean = false
  private readonly systemPrompt = `You are Wingman AI, an elite real-time technical & HR Interview Copilot helping a candidate score top marks in a live interview. Your absolute golden rules:
1. COMPLETE & DETAILED TECHNICAL DEPTH: Always provide complete, rich, highly accurate technical information covering exact architectural concepts, scaling trade-offs, internal mechanics, and industry use cases. Never give incomplete, shallow, or useless summaries.
2. SIMPLE DAILY ENGLISH WORDS ONLY: Explain every deep technical concept using clear, simple, daily conversational English words that anyone can speak naturally aloud. Do NOT use complex academic words (avoid 'heterogeneous', 'encapsulate', 'paradigm', 'mitigate', 'facilitate').
3. EXACT 5-6 STRUCTURED BULLET POINTS: Format your response directly into 5 to 6 distinct, highly scannable bullet points starting with '• ' where each point covers one crucial interview concept thoroughly (~150 to 180 words total).`
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"

  constructor(apiKey?: string, useOllama: boolean = false, ollamaModel?: string, ollamaUrl?: string) {
    this.useOllama = useOllama
    
    if (useOllama) {
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest"
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)
      this.initializeOllamaModel()
    } else if (apiKey) {
      this.apiKey = apiKey
      this.genAI = new GoogleGenerativeAI(apiKey)
      this.geminiModelName = "gemini-flash-lite-latest"
      this.model = this.genAI.getGenerativeModel({ 
        model: this.geminiModelName,
        generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
      })
      console.log(`[LLMHelper] Initialized with Ultra-Fast Gemini model: ${this.geminiModelName}`)
    } else {
      throw new Error("Either provide Gemini API key or enable Ollama mode")
    }
  }

  private async recoverWorkingGeminiModel(): Promise<GenerativeModel> {
    if (!this.genAI || !this.apiKey) {
      throw new Error("Cannot initialize Gemini without valid API key");
    }

    if (this.isRecovering && this.model) {
      return this.model;
    }
    this.isRecovering = true;
    console.log("[LLMHelper] Model/Network threw error. Searching for alternative working model...");

    const candidates = [
      "gemini-1.5-flash",
      "gemini-flash-lite-latest",
      "gemini-1.5-flash-latest",
      "gemini-1.5-flash-8b",
      "gemini-pro"
    ];

    for (const candidate of candidates) {
      if (candidate === this.geminiModelName && candidates.length > 1) continue;
      try {
        console.log(`[LLMHelper] Testing backup model '${candidate}'...`);
        const testModel = this.genAI.getGenerativeModel({ 
          model: candidate,
          generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
        });
        const result = await testModel.generateContent("hi");
        const response = await result.response;
        const responseText = response.text();
        if (responseText !== undefined) {
          this.geminiModelName = candidate;
          this.model = testModel;
          this.isRecovering = false;
          console.log(`[LLMHelper] ✅ Auto-recovered and locked onto model: ${this.geminiModelName}`);
          return this.model;
        }
      } catch (probeError: any) {
        const errMsg = probeError?.message || String(probeError);
        console.warn(`[LLMHelper] Backup model '${candidate}' check failed (${errMsg.substring(0, 60)}...)`);
        if (errMsg.includes("Quota") || errMsg.includes("rate limit") || errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED")) {
          this.isRecovering = false;
          throw new Error("⚠️ Google AI Studio Free Tier rate limit hit (15 requests/min). Please wait 20-30 seconds for the minute counter to reset, then try again.");
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
    }

    this.isRecovering = false;
    this.geminiModelName = "gemini-1.5-flash";
    this.model = this.genAI.getGenerativeModel({ 
      model: this.geminiModelName,
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
    });
    throw new Error("⚠️ Network/API Connection Error: Unable to reach Google Gemini servers ('fetch failed'). Please check your internet connection, VPN, or firewall and try again.");
  }

  private async getValidGeminiModel(): Promise<GenerativeModel> {
    if (this.model) {
      return this.model;
    }
    if (!this.genAI || !this.apiKey) {
      throw new Error("Gemini model not configured or API key missing");
    }
    this.geminiModelName = "gemini-flash-lite-latest";
    this.model = this.genAI.getGenerativeModel({ 
      model: this.geminiModelName,
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
    });
    return this.model;
  }

  private async executeWithAutoRecovery(generateFn: (model: GenerativeModel) => Promise<any>): Promise<any> {
    let model = await this.getValidGeminiModel();
    let lastError: any = null;

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        return await generateFn(model);
      } catch (error: any) {
        lastError = error;
        const msg = error?.message || String(error);
        
        if (msg.includes("Quota") || msg.includes("rate limit") || msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED")) {
          console.warn("[LLMHelper] Rate limit hit. Halting requests to let quota counter reset.");
          throw new Error("⚠️ Google AI Studio Free Tier rate limit hit (15 requests/min). Please wait 20-30 seconds for the minute counter to reset, then try again.");
        }

        if (msg.includes("404") || msg.includes("not found") || msg.includes("no longer available") || msg.includes("API version")) {
          console.warn(`[LLMHelper] Model '${this.geminiModelName}' threw 404/unavailable. Triggering Auto-Recovery...`);
          model = await this.recoverWorkingGeminiModel();
          return await generateFn(model);
        }

        if (msg.includes("fetch failed") || msg.includes("network") || msg.includes("ECONNRESET") || msg.includes("ETIMEDOUT") || msg.includes("ENOTFOUND")) {
          console.warn(`[LLMHelper] Network glitch on attempt ${attempt}/2 ('${msg.substring(0, 50)}...'). Retrying over fresh IPv4 socket...`);
          if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 600));
            continue;
          }
        }

        break;
      }
    }

    const finalMsg = lastError?.message || String(lastError);
    if (finalMsg.includes("fetch failed") || finalMsg.includes("network")) {
      throw new Error("⚠️ Network Connection Error ('fetch failed'). Windows could not establish a connection to Google's AI servers. Please check if your WiFi/Internet is active, or if an Antivirus/VPN is blocking Node.js.");
    }
    throw lastError;
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  private cleanJsonResponse(text: string): string {
    text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    text = text.trim();
    return text;
  }

  private async callOllama(prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          }
        }),
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error: any) {
      console.error("[LLMHelper] Error calling Ollama:", error)
      throw new Error(`Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`)
    }
  }

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
      const availableModels = await this.getOllamaModels()
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }

      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0]
        console.log(`[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`)
      }

      await this.callOllama("Hello")
      console.log(`[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`)
    } catch (error: any) {
      console.error(`[LLMHelper] Failed to initialize Ollama model: ${error.message}`)
      try {
        const models = await this.getOllamaModels()
        if (models.length > 0) {
          this.ollamaModel = models[0]
          console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`)
        }
      } catch (fallbackError: any) {
        console.error(`[LLMHelper] Fallback also failed: ${fallbackError.message}`)
      }
    }
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const imageParts = await Promise.all(imagePaths.map(path => this.fileToGenerativePart(path)))
      
      const prompt = `${this.systemPrompt}\n\nYou are a wingman helping the candidate. Please analyze these images and extract complete, detailed technical information in clean JSON format using ONLY SIMPLE, EASY DAILY ENGLISH WORDS:\n{
  "problem_statement": "A complete, detailed restatement of the problem in easy daily words.",
  "context": "Complete background rules and technical constraints explained simply.",
  "suggested_responses": [
    "• Detailed Concept: Complete, accurate definition explained in simple words (~25 words)",
    "• Internal Mechanism: How it works step-by-step in simple words (~25 words)",
    "• Scaling & Speed: Complete performance explanation in simple words (~25 words)",
    "• Real Industry Example: Detailed real-world app or company scenario in simple words (~25 words)",
    "• Pro Tip: High-scoring architectural tip to tell the interviewer in simple words (~25 words)"
  ],
  "reasoning": "Complete, accurate technical explanation in simple daily words."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        const text = this.cleanJsonResponse(response.text());
        return JSON.parse(text);
      });
    } catch (error) {
      console.error("Error extracting problem from images:", error)
      throw error
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `${this.systemPrompt}\n\nGiven this problem or interview topic:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format using ONLY SIMPLE, EASY DAILY ENGLISH WORDS so the candidate can speak it immediately with complete technical depth:\n{
  "solution": {
    "code": "Clean optimal code solution (if coding question) or complete summary text.",
    "problem_statement": "Restate the core interview question clearly and completely in simple words.",
    "context": "Complete technical context explained simply.",
    "suggested_responses": [
      "• Core Concept & Definition: Complete, detailed explanation of what it is and how it works using simple words (~30 words)",
      "• Primary Mechanism / Architecture: Exact internal structure or data handling explained clearly (~30 words)",
      "• Performance & Scalability Trade-off: Exact speed, latency, and scaling differences explained simply (~30 words)",
      "• Rules & Guarantees: How accuracy or transactions are handled (like ACID vs BASE) in simple words (~30 words)",
      "• Real-World Industry Use Case: Exact real-world example explaining when and why top companies choose this (~30 words)",
      "• Pro Tip for Bonus Marks: High-impact architectural best practice to impress the interviewer (~25 words)"
    ],
    "reasoning": "Why this approach is best."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

    console.log("[LLMHelper] Calling Gemini LLM for solution...");
    try {
      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent(prompt);
        console.log("[LLMHelper] Gemini LLM returned result.");
        const response = await result.response;
        const text = this.cleanJsonResponse(response.text());
        const parsed = JSON.parse(text);
        console.log("[LLMHelper] Parsed LLM response:", parsed);
        return parsed;
      });
    } catch (error) {
      console.error("[LLMHelper] Error in generateSolution:", error);
      throw error;
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const imageParts = await Promise.all(debugImagePaths.map(path => this.fileToGenerativePart(path)))
      
      const prompt = `${this.systemPrompt}\n\nYou are a wingman helping the candidate debug during a live interview. Given:\n1. Topic: ${JSON.stringify(problemInfo, null, 2)}\n2. Current approach: ${currentCode}\n3. Debug info in images\n\nPlease provide complete, detailed debugging feedback in this JSON format using SIMPLE, EASY DAILY ENGLISH WORDS ONLY:\n{
  "solution": {
    "code": "The fixed optimal code.",
    "problem_statement": "Restate the error and broken logic completely in simple words.",
    "context": "Why the error occurred internally explained simply.",
    "suggested_responses": [
      "• Root Cause Analysis: Complete explanation of what broke step-by-step in simple words (~30 words)",
      "• Fix Applied & Logic: How our code solves the exact issue clearly (~30 words)",
      "• Performance Impact: Time/space complexity improvement explained simply (~25 words)",
      "• Production Prevention: Exact steps to prevent this error next time in simple words (~25 words)",
      "• Pro Tip for Interview: Architectural best practice to highlight (~25 words)"
    ],
    "reasoning": "Complete technical reasoning in simple words."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        const text = this.cleanJsonResponse(response.text());
        const parsed = JSON.parse(text);
        console.log("[LLMHelper] Parsed debug LLM response:", parsed);
        return parsed;
      });
    } catch (error) {
      console.error("Error debugging solution with images:", error)
      throw error
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      const audioData = await fs.promises.readFile(audioPath);
      const audioPart = {
        inlineData: {
          data: audioData.toString("base64"),
          mimeType: "audio/mp3"
        }
      };
      const directAudioPrompt = `Listen to the spoken interview question in this audio clip. Instantly extract the core question and directly give your COMPLETE, RICH, DETAILED interview answer in EXACTLY 5 to 6 bullet points starting with '• ' (~150 to 180 words total).
CRITICAL RULES: Explain every deep technical concept using ONLY SIMPLE, EASY DAILY CONVERSATIONAL ENGLISH WORDS. Do NOT use hard or academic words. Format strictly as:\n\n❓ QUESTION HEARD: [1-line exact question summary in simple words]\n\n💡 COMPLETE DETAILED INTERVIEW ANSWER (Simple English):\n• [Core Concept & Exact Definition]: Complete, detailed explanation of what it is and how it works using simple words (~30 words).\n• [Primary Mechanism / Architecture]: Exact internal structure or data handling explained clearly in simple words (~30 words).\n• [Performance & Scalability Trade-off]: Exact speed, latency, and scaling differences explained simply (~30 words).\n• [Rules & Guarantees]: How accuracy or transactions are handled (like ACID vs BASE) in simple words (~30 words).\n• [Real-World Industry Use Case]: Exact real-world example explaining when and why top companies choose this (~30 words).\n• [Pro Tip for Bonus Marks]: High-impact architectural best practice to impress the interviewer (~25 words).`;
      
      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: directAudioPrompt }, audioPart] }],
          generationConfig: { maxOutputTokens: 550, temperature: 0.2, topK: 20 }
        });
        const response = await result.response;
        const text = response.text().trim();
        return { text, timestamp: Date.now() };
      });
    } catch (error) {
      console.error("Error analyzing audio file:", error);
      throw error;
    }
  }

  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      const audioPart = {
        inlineData: {
          data,
          mimeType
        }
      };
      const directAudioPrompt = `Listen to the spoken interview question in this audio clip. Instantly extract the core question and directly give your COMPLETE, RICH, DETAILED interview answer in EXACTLY 5 to 6 bullet points starting with '• ' (~150 to 180 words total).
CRITICAL RULES: Explain every deep technical concept using ONLY SIMPLE, EASY DAILY CONVERSATIONAL ENGLISH WORDS. Do NOT use hard or academic words. Format strictly as:\n\n❓ QUESTION HEARD: [1-line exact question summary in simple words]\n\n💡 COMPLETE DETAILED INTERVIEW ANSWER (Simple English):\n• [Core Concept & Exact Definition]: Complete, detailed explanation of what it is and how it works using simple words (~30 words).\n• [Primary Mechanism / Architecture]: Exact internal structure or data handling explained clearly in simple words (~30 words).\n• [Performance & Scalability Trade-off]: Exact speed, latency, and scaling differences explained simply (~30 words).\n• [Rules & Guarantees]: How accuracy or transactions are handled (like ACID vs BASE) in simple words (~30 words).\n• [Real-World Industry Use Case]: Exact real-world example explaining when and why top companies choose this (~30 words).\n• [Pro Tip for Bonus Marks]: High-impact architectural best practice to impress the interviewer (~25 words).`;
      
      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent({
          contents: [{ role: 'user', parts: [{ text: directAudioPrompt }, audioPart] }],
          generationConfig: { maxOutputTokens: 550, temperature: 0.2, topK: 20 }
        });
        const response = await result.response;
        const text = response.text().trim();
        return { text, timestamp: Date.now() };
      });
    } catch (error) {
      console.error("Error analyzing audio from base64:", error);
      throw error;
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      const imageData = await fs.promises.readFile(imagePath);
      const imagePart = {
        inlineData: {
          data: imageData.toString("base64"),
          mimeType: "image/png"
        }
      };
      const prompt = `${this.systemPrompt}\n\nAnalyze this screenshot for a live interview. Provide your COMPLETE, RICH, DETAILED interview answer in EXACTLY 5 to 6 bullet points starting with '• ' (~150 to 180 words total). Explain every technical nuance using ONLY SIMPLE, EASY DAILY ENGLISH WORDS. Never use hard academic vocabulary. Be complete, detailed, and structured.`;
      return await this.executeWithAutoRecovery(async (model) => {
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text().trim();
        return { text, timestamp: Date.now() };
      });
    } catch (error) {
      console.error("Error analyzing image file:", error);
      throw error;
    }
  }

  public async chatWithGemini(message: string): Promise<string> {
    try {
      if (this.useOllama) {
        return this.callOllama(message);
      } else {
        return await this.executeWithAutoRecovery(async (model) => {
          const fastPrompt = `${this.systemPrompt}\n\nCandidate Ask / Chat Question: "${message}"\n\nProvide your COMPLETE, RICH, DETAILED interview answer in EXACTLY 5 to 6 bullet points starting with '• ' (~150 to 180 words total).\nCRITICAL RULE: Explain every deep technical concept using ONLY SIMPLE, EASY DAILY CONVERSATIONAL ENGLISH WORDS. Do NOT use hard or academic words.\n\nFormat directly as:\n• [Core Concept & Exact Definition]: Complete, detailed explanation of what it is and how it works using simple words (~30 words).\n• [Primary Mechanism / Architecture]: Exact internal structure or data handling explained clearly in simple words (~30 words).\n• [Performance & Scalability Trade-off]: Exact speed, latency, and scaling differences explained simply (~30 words).\n• [Rules & Guarantees]: How accuracy or transactions are handled (like ACID vs BASE) in simple words (~30 words).\n• [Real-World Industry Use Case]: Exact real-world example explaining when and why top companies choose this (~30 words).\n• [Pro Tip for Bonus Marks]: High-impact architectural best practice to impress the interviewer (~25 words).\n\nDo NOT use introductory text or paragraphs. Keep strictly around 150 to 180 words total using 100% simple English while providing complete technical depth.`;
          const result = await model.generateContent(fastPrompt);
          const response = await result.response;
          return response.text().trim();
        });
      }
    } catch (error) {
      console.error("[LLMHelper] Error in chatWithGemini:", error);
      throw error;
    }
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGemini(message);
  }

  public isUsingOllama(): boolean {
    return this.useOllama;
  }

  public async getOllamaModels(): Promise<string[]> {
    if (!this.useOllama) return [];
    
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!response.ok) throw new Error('Failed to fetch models');
      
      const data = await response.json();
      return data.models?.map((model: any) => model.name) || [];
    } catch (error) {
      console.error("[LLMHelper] Error fetching Ollama models:", error);
      return [];
    }
  }

  public getCurrentProvider(): "ollama" | "gemini" {
    return this.useOllama ? "ollama" : "gemini";
  }

  public getCurrentModel(): string {
    return this.useOllama ? this.ollamaModel : this.geminiModelName;
  }

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true;
    if (url) this.ollamaUrl = url;
    
    if (model) {
      this.ollamaModel = model;
    } else {
      await this.initializeOllamaModel();
    }
    
    console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`);
  }

  public async switchToGemini(apiKey?: string): Promise<void> {
    if (apiKey) {
      this.apiKey = apiKey;
    }
    if (!this.apiKey) {
      throw new Error("No Gemini API key provided and no existing API key configured");
    }
    if (!this.genAI) {
      this.genAI = new GoogleGenerativeAI(this.apiKey);
    }
    this.model = null;
    this.geminiModelName = "gemini-flash-lite-latest";
    this.model = this.genAI!.getGenerativeModel({ 
      model: this.geminiModelName,
      generationConfig: { maxOutputTokens: 600, temperature: 0.3 }
    });
    this.useOllama = false;
    console.log(`[LLMHelper] Switched to Gemini (${this.geminiModelName})`);
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.useOllama) {
        const available = await this.checkOllamaAvailable();
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` };
        }
        await this.callOllama("Hello");
        return { success: true };
      } else {
        const model = await this.getValidGeminiModel();
        const result = await model.generateContent("Hello");
        const response = await result.response;
        const text = response.text();
        if (text) {
          return { success: true };
        } else {
          return { success: false, error: "Empty response from Gemini" };
        }
      }
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}