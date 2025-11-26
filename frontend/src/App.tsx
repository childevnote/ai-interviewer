import { useState, useRef, useEffect, ChangeEvent } from "react";
import axios from "axios";
import "./App.css";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

type Turn = "idle" | "ai" | "user" | "processing";

function App() {
  const [resumeText, setResumeText] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isInterviewing, setIsInterviewing] = useState<boolean>(false);
  const [turn, setTurn] = useState<Turn>("idle");
  const [timeLeft, setTimeLeft] = useState<number>(300);
  const [isTestMode, setIsTestMode] = useState<boolean>(false);

  // 자막 & 종료 상태
  const [captionText, setCaptionText] = useState<string>("");
  const [captionSpeaker, setCaptionSpeaker] = useState<"ai" | "user" | null>(
    null
  );
  const [isFinishing, setIsFinishing] = useState<boolean>(false);

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const requestRef = useRef<number | null>(null);
  const volumeBarRef = useRef<HTMLDivElement | null>(null);

  const SILENCE_THRESHOLD = 15;
  const SILENCE_DURATION = 3000;

  // 타이머
  useEffect(() => {
    let interval: number | undefined;
    if (isInterviewing && timeLeft > 0) {
      interval = setInterval(() => setTimeLeft((t) => t - 1), 1000);
    } else if (timeLeft === 0) {
      alert("시간이 종료되었습니다.");
      stopAll();
    }
    return () => clearInterval(interval);
  }, [isInterviewing, timeLeft]);

  // 테스트 모드 자동 답변 트리거
  useEffect(() => {
    if (isInterviewing && turn === "user" && isTestMode) {
      simulateUserResponse();
    }
  }, [turn, isInterviewing, isTestMode]);

  const stopAll = () => {
    setIsInterviewing(false);
    setCaptionText("");
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close();
    }
    if (requestRef.current) cancelAnimationFrame(requestRef.current);
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }
  };

  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await axios.post("http://localhost:8000/upload", formData);
      setResumeText(res.data.text);
    } catch (err) {
      console.error(err);
      alert("파일 업로드 실패");
    }
  };

  const startInterview = async () => {
    if (!resumeText) return alert("이력서를 먼저 업로드해주세요.");
    setIsInterviewing(true);
    setTurn("ai");

    const initialHistory: Message[] = [
      {
        role: "system",
        content: `당신은 면접관입니다. 다음 이력서를 보고 면접을 진행하세요: ${resumeText}`,
      },
      { role: "user", content: "면접을 시작해줘. 첫 인사를 해줘." },
    ];
    setMessages(initialHistory);
    await fetchAiResponse(initialHistory);
  };

  const fetchAiResponse = async (history: Message[]) => {
    setTurn("ai");
    setCaptionSpeaker("ai");
    setCaptionText("질문 생성 중...");

    try {
      const res = await axios.post("http://localhost:8000/chat", {
        message: "",
        history: history,
      });
      const { ai_message, audio_data, is_finished } = res.data;

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: ai_message },
      ]);
      setCaptionText(ai_message);

      if (is_finished) setIsFinishing(true);

      playAudio(audio_data);
    } catch (err) {
      console.error(err);
      setTurn("idle");
      setCaptionText("");
    }
  };

  const playAudio = (base64Audio: string) => {
    if (audioRef.current) {
      audioRef.current.src = `data:audio/mp3;base64,${base64Audio}`;
      audioRef.current.play().catch((e) => console.error("재생 오류:", e));
    }
  };

  const handleAudioEnded = () => {
    if (captionSpeaker === "ai") setCaptionText("");

    if (isFinishing) {
      alert("면접이 종료되었습니다. 수고하셨습니다!");
      stopAll();
      setIsFinishing(false);
      return;
    }

    if (isInterviewing) {
      if (!isTestMode) startRecording();
      else setTurn("user");
    }
  };

  // AI 지원자 시뮬레이션
  const simulateUserResponse = async () => {
    setCaptionSpeaker("user");
    setCaptionText("생각 중...");

    await new Promise((r) => setTimeout(r, 1500));

    try {
      const res = await axios.post("http://localhost:8000/simulate", {
        history: messages,
        resume_text: resumeText,
      });

      const simulatedAnswer = res.data.answer;
      setCaptionText(simulatedAnswer);

      const newMessages: Message[] = [
        ...messages,
        { role: "user", content: simulatedAnswer },
      ];
      setMessages(newMessages);

      await new Promise((r) => setTimeout(r, 2000));
      await fetchAiResponse(newMessages);
    } catch (err) {
      console.error("Simulation Error:", err);
      setTurn("idle");
    }
  };

  const startRecording = async () => {
    setTurn("user");
    setCaptionSpeaker("user");
    setCaptionText("듣고 있습니다..."); // 듣는 중 상태 표시

    try {
      if (
        audioContextRef.current &&
        audioContextRef.current.state !== "closed"
      ) {
        await audioContextRef.current.close();
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, {
          type: "audio/mp3",
        });
        await sendAudioToBackend(audioBlob);

        if (requestRef.current) cancelAnimationFrame(requestRef.current);
        stream.getTracks().forEach((track) => track.stop());
        if (volumeBarRef.current) volumeBarRef.current.style.width = "0%";
      };

      mediaRecorder.start();
      detectSilence(stream, mediaRecorder);
    } catch (err) {
      console.error("마이크 오류:", err);
      setTurn("idle");
    }
  };

  const detectSilence = (stream: MediaStream, mediaRecorder: MediaRecorder) => {
    const audioContext = new AudioContext();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    sourceRef.current = audioContext.createMediaStreamSource(stream);

    sourceRef.current.connect(analyser);
    analyser.fftSize = 512;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    silenceStartRef.current = null;

    const checkVolume = () => {
      if (!isInterviewing || isTestMode) return;

      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 5; i < bufferLength; i++) sum += dataArray[i];
      const averageVolume = sum / (bufferLength - 5);

      if (volumeBarRef.current) {
        const visualVol = Math.min(100, averageVolume * 3); // 민감도 증가
        volumeBarRef.current.style.width = `${visualVol}%`;
        volumeBarRef.current.style.backgroundColor =
          averageVolume < SILENCE_THRESHOLD ? "#d1d6db" : "#3182f6"; // 토스 컬러 적용
      }

      if (averageVolume < SILENCE_THRESHOLD) {
        if (silenceStartRef.current === null) {
          silenceStartRef.current = Date.now();
        } else {
          const silenceDuration = Date.now() - silenceStartRef.current;
          if (silenceDuration > SILENCE_DURATION) {
            if (mediaRecorder.state === "recording") {
              mediaRecorder.stop();
              return;
            }
          }
        }
      } else {
        silenceStartRef.current = null;
      }

      requestRef.current = requestAnimationFrame(checkVolume);
    };

    checkVolume();
  };

  const sendAudioToBackend = async (audioBlob: Blob) => {
    setTurn("processing");
    setCaptionText("답변 전송 중...");

    const formData = new FormData();
    formData.append("file", audioBlob);

    try {
      const sttRes = await axios.post("http://localhost:8000/stt", formData);
      const userText = sttRes.data.text;

      if (userText.trim()) {
        setCaptionText(userText);
        const newMessages: Message[] = [
          ...messages,
          { role: "user", content: userText },
        ];
        setMessages(newMessages);
        await fetchAiResponse(newMessages);
      } else {
        startRecording();
      }
    } catch (err) {
      console.error("STT 오류:", err);
      setTurn("idle");
      startRecording();
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  };

  return (
    <div className="app-container">
      <header>
        <h1>AI 모의 면접</h1>
        <div className="timer">{formatTime(timeLeft)}</div>
      </header>

      {!isInterviewing ? (
        <div className="setup-box">
          <div className="upload-area">
            <label className="file-label">
              <span style={{ fontSize: "24px", marginBottom: "8px" }}>📄</span>
              <span>이력서 PDF 업로드</span>
              <input
                type="file"
                accept=".pdf"
                onChange={handleFileUpload}
                hidden
              />
            </label>
            {resumeText && (
              <div className="file-status">✅ 이력서 분석 완료</div>
            )}
          </div>

          <div className="test-mode-card">
            <input
              type="checkbox"
              checked={isTestMode}
              onChange={(e) => setIsTestMode(e.target.checked)}
            />
            <span>자동 테스트 모드 켜기</span>
          </div>

          <button
            className="primary-btn"
            onClick={startInterview}
            disabled={!resumeText}
          >
            면접 시작하기
          </button>
        </div>
      ) : (
        <div className="interview-room">
          <div className="status-message">
            {turn === "ai" && (
              <>
                <span style={{ color: "#ff4b4b" }}>●</span> 면접관 질문 중
              </>
            )}
            {turn === "user" && !isTestMode && (
              <>
                <span style={{ color: "#3182f6" }}>●</span> 답변을 말씀해주세요
              </>
            )}
            {turn === "user" && isTestMode && (
              <>
                <span style={{ color: "#3182f6" }}>●</span> AI 지원자 답변 생성
                중
              </>
            )}
            {turn === "processing" && (
              <span style={{ color: "#8b95a1" }}>Thinking...</span>
            )}
          </div>

          <div className="avatars">
            <div
              className={`avatar-wrapper ai ${turn === "ai" ? "active" : ""}`}
            >
              <div className="avatar">🤖</div>
              <span className="avatar-name">면접관</span>
            </div>
            <div
              className={`avatar-wrapper user ${
                turn === "user" ? "active" : ""
              }`}
            >
              <div className="avatar">{isTestMode ? "🧪" : "🧑"}</div>
              <span className="avatar-name">
                {isTestMode ? "AI 지원자" : "나"}
              </span>
            </div>
          </div>

          {/* 볼륨 미터 (User 턴일 때만) */}
          {turn === "user" && !isTestMode && (
            <div className="volume-container">
              <div className="volume-bar-bg">
                <div
                  ref={volumeBarRef}
                  className="volume-bar-fill"
                  style={{ width: "0%" }}
                ></div>
              </div>
            </div>
          )}

          <div className="controls">
            <button
              className="secondary-btn"
              onClick={() => {
                stopAll();
                alert("면접을 종료합니다.");
              }}
            >
              면접 종료하기
            </button>
          </div>

          <audio ref={audioRef} onEnded={handleAudioEnded} hidden />

          {/* 하단 자막 오버레이 */}
          {captionText && (
            <div className="caption-overlay">
              <strong>
                {captionSpeaker === "ai"
                  ? "면접관"
                  : isTestMode
                  ? "AI 지원자"
                  : "나"}
              </strong>
              {captionText}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
