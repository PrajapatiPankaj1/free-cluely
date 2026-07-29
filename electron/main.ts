
import { app, BrowserWindow, Tray, Menu, nativeImage, session, systemPreferences } from "electron"
import path from "node:path"
import { initializeIpcHandlers } from "./ipcHandlers"
import { WindowHelper } from "./WindowHelper"
import { ScreenshotHelper } from "./ScreenshotHelper"
import { ShortcutsHelper } from "./shortcuts"
import { ProcessingHelper } from "./ProcessingHelper"

// ✅ FIX #7: Explicitly handle TLS warning (suppress it cleanly)
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

// ═══════════════════════════════════════════════════════════
// AppState — Singleton managing entire application state
// ═══════════════════════════════════════════════════════════

export class AppState {
  private static instance: AppState | null = null

  private windowHelper: WindowHelper
  private screenshotHelper: ScreenshotHelper
  public shortcutsHelper: ShortcutsHelper
  public processingHelper: ProcessingHelper
  private tray: Tray | null = null

  private view: "queue" | "solutions" = "queue"
  private problemInfo: any = null
  private hasDebugged: boolean = false

  public readonly PROCESSING_EVENTS = {
    UNAUTHORIZED: "procesing-unauthorized",
    NO_SCREENSHOTS: "processing-no-screenshots",
    INITIAL_START: "initial-start",
    PROBLEM_EXTRACTED: "problem-extracted",
    SOLUTION_SUCCESS: "solution-success",
    INITIAL_SOLUTION_ERROR: "solution-error",
    DEBUG_START: "debug-start",
    DEBUG_SUCCESS: "debug-success",
    DEBUG_ERROR: "debug-error"
  } as const

  constructor() {
    this.windowHelper = new WindowHelper(this)
    this.screenshotHelper = new ScreenshotHelper(this.view)
    this.processingHelper = new ProcessingHelper(this)
    this.shortcutsHelper = new ShortcutsHelper(this)
  }

  public static getInstance(): AppState {
    if (!AppState.instance) {
      AppState.instance = new AppState()
    }
    return AppState.instance
  }

  // ── Window Getters/Setters ────────────────────────
  public getMainWindow(): BrowserWindow | null {
    return this.windowHelper.getMainWindow()
  }

  public getView(): "queue" | "solutions" {
    return this.view
  }

  public setView(view: "queue" | "solutions"): void {
    this.view = view
    this.screenshotHelper.setView(view)
  }

  public getProblemInfo(): any {
    return this.problemInfo
  }

  public setProblemInfo(info: any): void {
    this.problemInfo = info
  }

  public getHasDebugged(): boolean {
    return this.hasDebugged
  }

  public setHasDebugged(value: boolean): void {
    this.hasDebugged = value
  }

  // ── Screenshot Queue ──────────────────────────────
  public getScreenshotQueue(): string[] {
    return this.screenshotHelper.getScreenshotQueue()
  }

  public getExtraScreenshotQueue(): string[] {
    return this.screenshotHelper.getExtraScreenshotQueue()
  }

  public clearQueues(): void {
    this.screenshotHelper.clearQueues()
  }

  // ── Window Management ─────────────────────────────
  public createWindow(): void {
    this.windowHelper.createWindow()

    // ✅ FIX #2: Enable content protection AFTER window creation
    const mainWindow = this.getMainWindow()
    if (mainWindow) {
      mainWindow.setContentProtection(true)
      console.log("[Stealth] Content protection enabled")
    }
  }

  public hideMainWindow(): void {
    this.windowHelper.hideMainWindow()
  }

  public showMainWindow(): void {
    this.windowHelper.showMainWindow()
  }

  public toggleMainWindow(): void {
    this.windowHelper.toggleMainWindow()
  }

  public centerAndShowWindow(): void {
    this.windowHelper.centerAndShowWindow()
  }

  // ── Window Movement ───────────────────────────────
  public moveWindowRight(): void {
    this.windowHelper.moveWindowRight()
  }

  public moveWindowLeft(): void {
    this.windowHelper.moveWindowLeft()
  }

  public moveWindowDown(): void {
    this.windowHelper.moveWindowDown()
  }

  public moveWindowUp(): void {
    this.windowHelper.moveWindowUp()
  }

  public setWindowDimensions(width: number, height: number): void {
    this.windowHelper.setWindowDimensions(width, height)
  }

  public isVisible(): boolean {
    return this.windowHelper.isVisible()
  }

  // ── Screenshot Operations ─────────────────────────
  public async takeScreenshot(): Promise<string> {
    if (!this.getMainWindow()) throw new Error("No main window available")

    const screenshotPath = await this.screenshotHelper.takeScreenshot(
      () => this.hideMainWindow(),
      () => this.showMainWindow()
    )

    return screenshotPath
  }

  public async getImagePreview(filepath: string): Promise<string> {
    return this.screenshotHelper.getImagePreview(filepath)
  }

  public async deleteScreenshot(
    filePath: string
  ): Promise<{ success: boolean; error?: string }> {
    return this.screenshotHelper.deleteScreenshot(filePath)
  }

  public getScreenshotHelper(): ScreenshotHelper {
    return this.screenshotHelper
  }

  // ── System Tray ───────────────────────────────────
  public createTray(): void {
    if (this.tray) return

    // ✅ FIX #5: Use multiple fallback paths for tray icon
    const possibleIconPaths = [
      path.join(__dirname, "../assets/icon.png"),
      path.join(__dirname, "../assets/icons/png/icon-256x256.png"),
      path.join(__dirname, "../assets/icons/icon.png"),
      path.join(process.cwd(), "assets/icon.png"),
    ]

    let iconPath: Electron.NativeImage | null = null
    let iconLoaded = false

    for (const iconFile of possibleIconPaths) {
      try {
        const testIcon = nativeImage.createFromPath(iconFile)
        if (!testIcon.isEmpty()) {
          iconPath = testIcon
          iconLoaded = true
          console.log("[Tray] Icon loaded from: " + iconFile)
          break
        }
      } catch {
        // Try next path
      }
    }

    // ✅ FIXED: Proper fallback without non-null assertion errors
    if (!iconLoaded) {
      console.warn("[Tray] No icon file found, using fallback empty icon")
      iconPath = nativeImage.createEmpty()
    }

    try {
      this.tray = new Tray(iconPath!)

      const contextMenu = Menu.buildFromTemplate([
        {
          label: "Show App",
          click: () => {
            this.showMainWindow()
          }
        },
        {
          label: "Take Screenshot",
          click: async () => {
            try {
              const screenshotPath = await this.takeScreenshot()
              const preview = await this.getImagePreview(screenshotPath)
              const mainWindow = this.getMainWindow()
              if (mainWindow) {
                mainWindow.webContents.send("screenshot-taken", {
                  path: screenshotPath,
                  preview
                })
              }
            } catch (error) {
              console.error("Error taking screenshot from tray:", error)
            }
          }
        },
        { type: "separator" },
        {
          label: "Quit",
          click: () => {
            app.quit()
          }
        }
      ])

      this.tray.setToolTip("Free Cluely - Invisible Assistant")
      this.tray.setContextMenu(contextMenu)
      console.log("[Tray] System tray created successfully")
    } catch (error) {
      console.error("[Tray] Failed to create tray:", error)
      this.tray = null
    }
  }

  // ✅ FIX #4: Cleanup method for graceful shutdown
  public async cleanup(): Promise<void> {
    console.log("[Cleanup] Shutting down gracefully...")

    if (this.tray) {
      this.tray.destroy()
      this.tray = null
    }

    this.clearQueues()
    this.problemInfo = null
    this.hasDebugged = false

    console.log("[Cleanup] Done")
  }
}


// ═══════════════════════════════════════════════════════════
// Application Initialization
// ═══════════════════════════════════════════════════════════

async function initializeApp() {
  // ✅ FIX #1: Single Instance Lock
  const gotTheLock = app.requestSingleInstanceLock()

  if (!gotTheLock) {
    console.log("[Init] Another instance is already running. Quitting...")
    app.quit()
    return
  }

  app.on("second-instance", () => {
    const appState = AppState.getInstance()
    const mainWindow = appState.getMainWindow()
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  const appState = AppState.getInstance()
  initializeIpcHandlers(appState)

  // ✅ FIX #3: Disable Chromium background throttling
  app.commandLine.appendSwitch("disable-background-timer-throttling")
  app.commandLine.appendSwitch("disable-renderer-backgrounding")
  app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion")

  app.whenReady().then(() => {
    console.log("[Init] App is ready")

    // ── Permission Handlers ───────────────────────
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = [
          'media',
          'mediaKeySystem',
          'geolocation',
          'notifications',
          'midi',
          'pointerLock',
          'fullscreen',
          'openExternal',
          'microphone',
          'audioCapture',
          'clipboard-read',
          'clipboard-sanitized-write'
        ]
        callback(allowedPermissions.includes(permission))
      }
    )

    session.defaultSession.setPermissionCheckHandler(
      (_webContents, permission) => {
        const allowedPermissions = ['media', 'microphone', 'audioCapture']
        return allowedPermissions.includes(permission)
      }
    )

    // macOS: Request microphone permission
    if (process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
      systemPreferences.askForMediaAccess('microphone').catch(err =>
        console.error("[Init] Error asking for media access:", err)
      )
    }

    // ── Create Window & Tray ──────────────────────
    appState.createWindow()
    appState.createTray()
    appState.shortcutsHelper.registerGlobalShortcuts()

    // ✅ FIX #6: Hide dock icon on macOS
    if (process.platform === 'darwin') {
      app.dock?.hide()
      console.log("[Stealth] Dock icon hidden")
    }

    console.log("[Init] Application fully initialized ✅")
  })

  // ── macOS activate handler ──────────────────────
  app.on("activate", () => {
    console.log("[Event] App activated")
    if (appState.getMainWindow() === null) {
      appState.createWindow()
    } else {
      appState.showMainWindow()
    }
  })

  // ── Window close handler ────────────────────────
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })

  // ✅ FIX #4: Cleanup on quit
  app.on("will-quit", async () => {
    await appState.cleanup()
  })

  // Handle uncaught errors gracefully
  process.on("uncaughtException", (error) => {
    console.error("[Error] Uncaught Exception:", error.message)
  })

  process.on("unhandledRejection", (reason) => {
    console.error("[Error] Unhandled Rejection:", reason)
  })
}

// ── Start the application ────────────────────────────
initializeApp().catch((error) => {
  console.error("[Fatal] App initialization failed:", error)
  app.quit()
})
