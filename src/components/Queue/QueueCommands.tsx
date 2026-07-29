import React, { useState, useEffect, useRef } from "react"
import { IoLogOutOutline } from "react-icons/io5"
import { Dialog, DialogContent, DialogClose } from "../ui/dialog"

interface QueueCommandsProps {
  onTooltipVisibilityChange: (visible: boolean, height: number) => void
  screenshots: Array<{ path: string; preview: string }>
  onChatToggle: () => void
  onSettingsToggle: () => void
}

const QueueCommands: React.FC<QueueCommandsProps> = ({
  onTooltipVisibilityChange,
  screenshots,
  onChatToggle,
  onSettingsToggle
}) => {
  const [isTooltipVisible, setIsTooltipVisible] = useState(false)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [isRecording, setIsRecording] = useState(false)
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null)
  const [audioResult, setAudioResult] = useState<string | null>(null)
  const chunks = useRef<Blob[]>([])

  useEffect(() => {
    let tooltipHeight = 0
    if (tooltipRef.current && isTooltipVisible) {
      tooltipHeight = tooltipRef.current.offsetHeight + 10
    }
    onTooltipVisibilityChange(isTooltipVisible, tooltipHeight)
  }, [isTooltipVisible])

  const handleMouseEnter = () => {
    setIsTooltipVisible(true)
  }

  const handleMouseLeave = () => {
    setIsTooltipVisible(false)
  }

  const handleRecordClick = async () => {
    if (!isRecording) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        // 16 kbps mono bitrate ensures super-fast 0.1s Base64 upload
        const recorder = new MediaRecorder(stream, { audioBitsPerSecond: 16000 })
        recorder.ondataavailable = (e) => chunks.current.push(e.data)
        recorder.onstop = async () => {
          const blob = new Blob(chunks.current, { type: chunks.current[0]?.type || 'audio/webm' })
          chunks.current = []
          
          // Cleanly release microphone tracks so Windows red mic icon disappears
          stream.getTracks().forEach(track => track.stop())

          const reader = new FileReader()
          reader.onloadend = async () => {
            const base64Data = (reader.result as string).split(',')[1]
            try {
              setAudioResult("⚡ Processing voice with Gemini (~2.5s)...")
              const result = await window.electronAPI.analyzeAudioFromBase64(base64Data, blob.type)
              setAudioResult(result.text)
            } catch (err) {
              setAudioResult('Audio analysis failed.')
            }
          }
          reader.readAsDataURL(blob)
        }
        setMediaRecorder(recorder)
        recorder.start()
        setIsRecording(true)
        setAudioResult("Recording... Speak your interview question now.")
      } catch (err: any) {
        console.error("Error capturing audio stream:", err);
        const errorMsg = err?.message || String(err);
        if (errorMsg.includes("Permission") || errorMsg.includes("NotAllowed")) {
          setAudioResult('Microphone permission denied. Enable Mic access in Windows Privacy Settings.');
        } else if (errorMsg.includes("NotFound") || errorMsg.includes("DevicesNotFound")) {
          setAudioResult('No microphone found. Please connect a mic.');
        } else {
          setAudioResult(`Could not start recording (${errorMsg}).`);
        }
      }
    } else {
      mediaRecorder?.stop()
      setIsRecording(false)
      setMediaRecorder(null)
    }
  }

  return (
    <div className="w-fit">
      <div className="text-xs text-white/90 liquid-glass-bar py-1 px-4 flex items-center justify-center gap-4 draggable-area">
        {/* Show/Hide */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] leading-none">Show/Hide</span>
          <div className="flex gap-1">
            <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              ⌘
            </button>
            <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              B
            </button>
          </div>
        </div>

        {/* Solve */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] leading-none">Solve</span>
          <div className="flex gap-1">
            <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              ⌘
            </button>
            <button className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-1.5 py-1 text-[11px] leading-none text-white/70">
              ↵
            </button>
          </div>
        </div>

        {/* Voice Recording Button */}
        <div className="flex items-center gap-2">
          <button
            className={`bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1 ${
              isRecording ? 'bg-red-500/70 hover:bg-red-500/90' : ''
            }`}
            onClick={handleRecordClick}
            type="button"
          >
            {isRecording ? (
              <span className="animate-pulse">● Stop Recording</span>
            ) : (
              <span>🎤 Record Voice</span>
            )}
          </button>
        </div>

        {/* Chat Button */}
        <div className="flex items-center gap-2">
          <button
            className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1"
            onClick={onChatToggle}
            type="button"
          >
            💬 Chat
          </button>
        </div>

        {/* Settings Button */}
        <div className="flex items-center gap-2">
          <button
            className="bg-white/10 hover:bg-white/20 transition-colors rounded-md px-2 py-1 text-[11px] leading-none text-white/70 flex items-center gap-1"
            onClick={onSettingsToggle}
            type="button"
          >
            ⚙️ Models
          </button>
        </div>

        {/* Shortcuts Help */}
        <div
          ref={tooltipRef}
          onMouseEnter={handleMouseEnter}
          onMouseLeave={handleMouseLeave}
          className="relative inline-block"
        >
          <div className="w-6 h-6 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-colors flex items-center justify-center cursor-help z-10">
            <span className="text-xs text-white/70">?</span>
          </div>

          {isTooltipVisible && (
            <div className="absolute top-full right-0 mt-2 w-80 z-50">
              <div className="p-3 text-xs bg-black/85 backdrop-blur-md rounded-lg border border-white/20 text-white/90 shadow-2xl">
                <div className="space-y-4">
                  <div>
                    <h3 className="font-semibold text-yellow-300 mb-2">Shortcuts</h3>
                    <div className="space-y-1 text-white/85">
                      <div>Show/Hide: ⌘/Ctrl + B</div>
                      <div>Center & Show: ⌘/Ctrl + Shift + Space</div>
                      <div>Take Screenshot: ⌘/Ctrl + H</div>
                      <div>Solve: ⌘/Ctrl + Enter</div>
                      <div>Reset/Clear: ⌘/Ctrl + R</div>
                      <div>Move Window: ⌘/Ctrl + Arrow Keys</div>
                    </div>
                  </div>

                  <div>
                    <h3 className="font-semibold text-yellow-300 mb-2">Queue Status</h3>
                    <div className="text-white/85">
                      Screenshots queued: {screenshots.length}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Quit Button */}
        <div className="flex items-center gap-2">
          <button
            className="bg-white/10 hover:bg-red-500/30 transition-colors rounded-md p-1.5 text-white/70 hover:text-red-300 flex items-center justify-center"
            onClick={() => window.electronAPI.quitApp()}
            type="button"
            title="Quit App"
          >
            <IoLogOutOutline className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Audio processing status display with clean line formatting */}
      {audioResult && (
        <div 
          className="mt-2 p-3 bg-black/85 backdrop-blur-md rounded-lg border border-white/20 text-white/95 text-xs max-w-lg shadow-2xl font-medium"
          style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", lineHeight: "1.5" }}
        >
          <div className="font-semibold text-yellow-300 mb-1">🎤 Interview Copilot Voice Result:</div>
          <div>{audioResult.replace(/\*\*/g, '').replace(/###\s*\d*\.?\s*/g, '').replace(/---\s*/g, '')}</div>
        </div>
      )}
    </div>
  )
}

export default QueueCommands