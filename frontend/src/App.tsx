import { useState, useRef, useEffect, ChangeEvent } from "react";
import axios from "axios";
import "./App.css";

interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

const JOB_ROLES = [
  "개발자 (공통)",
  "프론트엔드",
  "백엔드",
  "풀스택",
  "디자이너",
  "기획자(PM/PO)",
  "정보보안",
  "AI/머신러닝",
];

interface HistoryItem {
  id: number;
  date: string;
  score: number;
  feedback: string;
  summary: string;
}

// [추가] 신뢰도 데이터 타입 정의
interface Reliability {
  score: number;
  reason: string;
}

type Turn = "idle" | "ai" | "user" | "processing";

function App() {
  const [resumeText, setResumeText] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isInterviewing, setIsInterviewing] = useState<boolean>(false);
  const [turn, setTurn] = useState<Turn>("idle");
  const [timeLeft, setTimeLeft] = useState<number>(300);
  const [isTestMode, setIsTestMode] = useState<boolean>(false);
  const [selectedRole, setSelectedRole] = useState<string>("");
  // 자막 & 종료
  const [captionText, setCaptionText] = useState<string>("");
  const [captionSpeaker, setCaptionSpeaker] = useState<"ai" | "user" | null>(
    null
  );
  const [isFinishing, setIsFinishing] = useState<boolean>(false);

  // 결과 및 기록 상태
  const [evaluation, setEvaluation] = useState<HistoryItem | null>(null);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);

  // [추가] 신뢰도 및 로딩 상태
  const [reliability, setReliability] = useState<Reliability | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);

  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const requestRef = useRef<number | null>(null);
  const volumeBarRef = useRef<HTMLDivElement | null>(null);

  // 평가 중복 방지 락(Lock)
  const isEvaluatingRef = useRef<boolean>(false);

  const SILENCE_THRESHOLD = 15;
  const SILENCE_DURATION = 3000;

  useEffect(() => {
    let interval: number | undefined;
    if (isInterviewing && timeLeft > 0) {
      interval = setInterval(() => setTimeLeft((t) => t - 1), 1000);
    } else if (timeLeft === 0) {
      alert("시간이 종료되었습니다.");
      finishInterview();
    }
    return () => clearInterval(interval);
  }, [isInterviewing, timeLeft]);

  useEffect(() => {
    if (isInterviewing && turn === "user" && isTestMode) {
      simulateUserResponse();
    }
  }, [turn, isInterviewing, isTestMode]);

  const finishInterview = async () => {
    if (isEvaluatingRef.current) return; // 이미 평가 중이면 중단
    isEvaluatingRef.current = true; // 잠금 설정
    setIsFinishing(false);

    stopAll();
    setCaptionText("📝 면접관이 평가 중입니다...");

    try {
      const res = await axios.post("http://localhost:8000/evaluate", {
        history: messages,
      });
      setEvaluation(res.data);
    } catch (err) {
      console.error(err);
      alert("평가 중 오류가 발생했습니다.");
    }
  };

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

  const fetchHistory = async () => {
    try {
      const res = await axios.get("http://localhost:8000/history");
      setHistoryList(res.data);
      setShowHistory(true);
    } catch (err) {
      console.error(err);
    }
  };

  // [핵심] 파일 업로드 함수 수정됨
  const handleFileUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 1. 상태 초기화 및 로딩 시작
    setResumeText("");
    setReliability(null);
    setIsUploading(true); // 여기서 로딩 화면을 켭니다.

    const formData = new FormData();
    formData.append("file", file);

    try {
      // 2. 서버 요청 (이 시간 동안 로딩 화면이 보임)
      const res = await axios.post("http://localhost:8000/upload", formData);
      setResumeText(res.data.text);
      setReliability(res.data.reliability);
    } catch (err) {
      console.error(err);
      alert("파일 업로드 및 분석 실패");
    } finally {
      // 3. 성공하든 실패하든 로딩 종료
      setIsUploading(false);
    }
  };

  const startInterview = async () => {
    if (!resumeText) return alert("이력서를 먼저 업로드해주세요.");

    isEvaluatingRef.current = false; // 평가 락 해제
    setIsInterviewing(true);
    setEvaluation(null);
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
        role: selectedRole, // 🔥 선택된 직무 전송
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
      setIsFinishing(false);
      finishInterview();
      return;
    }

    if (isInterviewing) {
      if (!isTestMode) startRecording();
      else setTurn("user");
    }
  };

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
    setCaptionText("듣고 있습니다...");

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
        const visualVol = Math.min(100, averageVolume * 3);
        volumeBarRef.current.style.width = `${visualVol}%`;
        volumeBarRef.current.style.backgroundColor =
          averageVolume < SILENCE_THRESHOLD ? "#d1d6db" : "#3182f6";
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
        {!showHistory && <div className="timer">{formatTime(timeLeft)}</div>}
      </header>

      {/* 1. 면접 기록 보기 모드 */}
      {showHistory ? (
        <div className="history-container">
          <button className="back-btn" onClick={() => setShowHistory(false)}>
            ← 뒤로가기
          </button>
          <h2>📂 지난 면접 기록</h2>
          <div className="history-list">
            {historyList.length === 0 ? (
              <p>기록이 없습니다.</p>
            ) : (
              historyList.map((item) => (
                <div key={item.id} className="history-card">
                  <div className="history-header">
                    <span className="history-date">{item.date}</span>
                    <span
                      className={`history-score ${
                        item.score >= 80 ? "high" : "low"
                      }`}
                    >
                      {item.score}점
                    </span>
                  </div>
                  <p className="history-summary">{item.summary}</p>
                  <div className="history-feedback">
                    <strong>피드백:</strong> {item.feedback}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : /* 2. 일반 모드 (설정 or 면접) */
      !isInterviewing ? (
        <div className="setup-box">
          {/* 결과 모달 (면접 직후) */}
          {evaluation && (
            <div className="result-card">
              <h3>🎉 면접 결과 리포트</h3>
              <div className="score-display">{evaluation.score}점</div>
              <p className="feedback-text">{evaluation.feedback}</p>
              <button
                className="primary-btn"
                onClick={() => setEvaluation(null)}
              >
                확인
              </button>
            </div>
          )}

          {!evaluation && (
            <>
              {/* === [수정된 부분] 로딩 화면 및 결과 표시 === */}
              <div className="upload-area">
                {isUploading ? (
                  // 1. 로딩 중 화면
                  <div className="loading-container">
                    <div className="spinner"></div>
                    <div className="loading-text">
                      <strong>AI가 이력서를 분석 중입니다...</strong>
                      <br />
                      <span style={{ fontSize: "12px", color: "#888" }}>
                        신뢰도 측정 및 내용을 요약하고 있습니다.
                      </span>
                    </div>
                  </div>
                ) : (
                  // 2. 평상시 (업로드 버튼)
                  <label
                    className={`file-label ${resumeText ? "uploaded" : ""}`}
                  >
                    <span style={{ fontSize: "24px", marginBottom: "8px" }}>
                      {resumeText ? "✅" : "📄"}
                    </span>
                    <span>
                      {resumeText ? "이력서 재업로드" : "이력서 PDF 업로드"}
                    </span>
                    <input
                      type="file"
                      accept=".pdf"
                      onChange={handleFileUpload}
                      hidden
                    />
                  </label>
                )}

                {/* 3. 로딩 완료 후 분석 결과 카드 */}
                {!isUploading && resumeText && reliability && (
                  <div
                    className="resume-status-card"
                    style={{
                      marginTop: "15px",
                      padding: "15px",
                      background: "#f8f9fa",
                      borderRadius: "8px",
                      textAlign: "left",
                      border: "1px solid #e1e4e8",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: "8px",
                      }}
                    >
                      <strong>📊 분석 완료</strong>
                      <span
                        style={{
                          fontWeight: "bold",
                          color:
                            reliability.score >= 80
                              ? "#2196f3"
                              : reliability.score >= 50
                              ? "#ff9800"
                              : "#f44336",
                        }}
                      >
                        신뢰도 {reliability.score}점
                      </span>
                    </div>

                    <p
                      style={{
                        fontSize: "14px",
                        color: "#4e5968",
                        margin: "0 0 8px 0",
                        lineHeight: "1.4",
                      }}
                    >
                      {reliability.reason}
                    </p>

                    {/* 경고창 (50점 미만) */}
                    {reliability.score < 50 && (
                      <div
                        style={{
                          marginTop: "10px",
                          padding: "8px",
                          backgroundColor: "#ffebee",
                          color: "#c62828",
                          fontSize: "13px",
                          borderRadius: "4px",
                          border: "1px solid #ffcdd2",
                        }}
                      >
                        ⚠️ <strong>주의:</strong> 이력서 내용이 너무 부족합니다.{" "}
                        <br />
                        면접 질문이 정확하지 않을 수 있습니다.
                      </div>
                    )}
                    {resumeText && !isUploading && (
                      <div
                        className="role-selection"
                        style={{ marginTop: "20px", textAlign: "left" }}
                      >
                        <h3
                          style={{
                            fontSize: "16px",
                            marginBottom: "10px",
                            color: "#333",
                          }}
                        >
                          💼 지원 직무를 선택해주세요
                        </h3>
                        <div
                          style={{
                            display: "flex",
                            flexWrap: "wrap",
                            gap: "8px",
                          }}
                        >
                          {JOB_ROLES.map((role) => (
                            <button
                              key={role}
                              className={`role-badge ${
                                selectedRole === role ? "selected" : ""
                              }`}
                              onClick={() => setSelectedRole(role)}
                              style={{
                                padding: "8px 16px",
                                borderRadius: "20px",
                                border:
                                  selectedRole === role
                                    ? "1px solid #3182f6"
                                    : "1px solid #d1d6db",
                                backgroundColor:
                                  selectedRole === role ? "#e8f3ff" : "#fff",
                                color:
                                  selectedRole === role ? "#3182f6" : "#6b7684",
                                cursor: "pointer",
                                fontSize: "14px",
                                fontWeight:
                                  selectedRole === role ? "bold" : "normal",
                                transition: "all 0.2s",
                              }}
                            >
                              {role}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
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
                // 🔥 직무 미선택 시 시작 불가하도록 변경
                disabled={!resumeText || isUploading || !selectedRole}
                style={{
                  opacity:
                    !resumeText || isUploading || !selectedRole ? 0.5 : 1,
                }}
              >
                면접 시작하기
              </button>

              <button className="secondary-btn" onClick={fetchHistory}>
                지난 기록 보기
              </button>
            </>
          )}
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
                finishInterview();
              }}
            >
              면접 종료하기
            </button>
          </div>

          <audio ref={audioRef} onEnded={handleAudioEnded} hidden />

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
