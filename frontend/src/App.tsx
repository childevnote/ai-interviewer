import { useState, useRef, useEffect } from "react";
import type { ChangeEvent } from "react";
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
  const [isTestMode, setIsTestMode] = useState<boolean>(false);
  const [selectedRole, setSelectedRole] = useState<string>("");
  const [targetQuestionCount, setTargetQuestionCount] = useState<number>(5);
  // 자막 & 종료
  const [captionText, setCaptionText] = useState<string>("");
  const [captionSpeaker, setCaptionSpeaker] = useState<"ai" | "user" | null>(
    null
  );
  const [isFinishing, setIsFinishing] = useState<boolean>(false);

  const [hintText, setHintText] = useState<string>("");
  const [showHint, setShowHint] = useState<boolean>(false);
  const [isHintLoading, setIsHintLoading] = useState<boolean>(false);

  // 결과 및 기록 상태
  const [evaluation, setEvaluation] = useState<HistoryItem | null>(null);
  const [showHistory, setShowHistory] = useState<boolean>(false);
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);

  // [추가] 신뢰도 및 로딩 상태
  const [reliability, setReliability] = useState<Reliability | null>(null);
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  // Refs
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const silenceStartRef = useRef<number | null>(null);
  const requestRef = useRef<number | null>(null);
  const volumeBarRef = useRef<HTMLDivElement | null>(null);
const isPausedRef = useRef<boolean>(false);
  // 평가 중복 방지 락(Lock)
  const isEvaluatingRef = useRef<boolean>(false);

  const SILENCE_THRESHOLD = 15;
  const SILENCE_DURATION = 5000;

const getCurrentQuestionCount = () => {
    return messages.filter(m => m.role === "assistant").length;
  };

  useEffect(() => {
    if (isInterviewing && turn === "user" && isTestMode) {
      simulateUserResponse();
    }
  }, [turn, isInterviewing, isTestMode]);
  const handleResumeInterview = () => {
    setShowHint(false);
    isPausedRef.current = false;
    
    // 다시 사용자 턴으로 설정하고 녹음 시작
    // 만약 AI가 말을 하던 중에 끊었다면 다시 듣게 할지, 바로 대답할지 결정해야 함.
    // 여기서는 "대답하기" 버튼이므로 바로 사용자 녹음을 시작합니다.
    startRecording(); 
  };

  const finishInterview = async () => {
    if (isEvaluatingRef.current) return;
    isEvaluatingRef.current = true;

    setIsFinishing(false);
    setIsEvaluating(true);
    stopAll();
    setCaptionText("");

    try {
      const res = await axios.post("http://localhost:8000/evaluate", {
        history: messages,
      });
      setEvaluation(res.data);
    } catch (err) {
      console.error(err);
      alert("평가 중 오류가 발생했습니다.");
    } finally {
      setIsEvaluating(false);
      isEvaluatingRef.current = false;
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

    setHintText("");
    setShowHint(false);
    isPausedRef.current = false;

    try {
      const res = await axios.post("http://localhost:8000/chat", {
        message: "",
        history: history,
        role: selectedRole,
        question_count: targetQuestionCount,
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

const handleHintToggle = async () => {
    // 이미 힌트가 켜져 있다면 -> 닫기 버튼 역할 (재개)
    if (showHint) {
      handleResumeInterview();
      return;
    }

    // --- 일시정지 시작 ---
    isPausedRef.current = true; // 마이크 onstop 이벤트가 백엔드로 전송되는 것을 막음

    // 1) AI 오디오 중단
    if (audioRef.current) {
      audioRef.current.pause();
    }

    // 2) 마이크/녹음 중단
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (audioContextRef.current && audioContextRef.current.state !== "closed") {
      audioContextRef.current.close(); // 오디오 컨텍스트 닫기 (침묵 감지 중단)
    }
    if (requestRef.current) cancelAnimationFrame(requestRef.current); // 애니메이션 프레임 중단
    
    // 시각적 피드백
    setCaptionText("⏸️ 힌트를 확인하는 동안 면접이 일시정지되었습니다.");

    // 3) 힌트 로딩 로직
    if (hintText) {
      setShowHint(true); // 이미 텍스트가 있으면 바로 보여줌
      return;
    }

    setIsHintLoading(true);
    try {
      const lastAiMessage = [...messages].reverse().find(m => m.role === "assistant");
      if (!lastAiMessage) {
        alert("현재 답변할 질문이 없습니다.");
        handleResumeInterview(); // 실패 시 바로 재개
        return;
      }

      const res = await axios.post("http://localhost:8000/hint", {
        question: lastAiMessage.content,
        resume_text: resumeText,
        role: selectedRole
      });

      setHintText(res.data.hint);
      setShowHint(true);
    } catch (err) {
      console.error(err);
      alert("힌트를 불러오는데 실패했습니다.");
      handleResumeInterview(); // 실패 시 재개
    } finally {
      setIsHintLoading(false);
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
    isPausedRef.current = false; // 재개 시 플래그 초기화

    try {
      if (audioContextRef.current && audioContextRef.current.state !== "closed") {
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
        // [수정] 힌트 보기로 인해 일시정지된 경우, 백엔드로 전송하지 않음
        if (isPausedRef.current) {
            // 스트림 트랙 정리만 하고 종료
            stream.getTracks().forEach((track) => track.stop());
            return; 
        }

        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/mp3" });
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

  return (
    <div className="app-container">
      <header>
        <h1>AI 모의 면접</h1>
        {!showHistory && isInterviewing && (
           <div className="timer" style={{ fontSize: "18px", background: "#333", padding: "5px 15px" }}>
             Q. {getCurrentQuestionCount()} / {targetQuestionCount}
           </div>
        )}
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
      ) : !isInterviewing ? (
        <div className="setup-box">
          {evaluation ? (
            /* === 결과 리포트 화면 === */
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
          ) : isEvaluating ? (
            /* === [추가됨] 평가 분석 중 로딩 화면 === */
            <div className="loading-container">
              <div className="spinner"></div>
              <div className="loading-text">
                <strong>수고하셨습니다!</strong>
                <br />
                <span style={{ fontSize: "16px", color: "#333" }}>
                  면접관이 결과를 작성하고 있습니다...
                </span>
                <br />
                <span
                  style={{
                    fontSize: "12px",
                    color: "#888",
                    marginTop: "10px",
                    display: "block",
                  }}
                >
                  대화 내용 분석 및 피드백 생성 중
                </span>
              </div>
            </div>
          ) : (
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
                        <h3 style={{ fontSize: "16px", marginBottom: "10px", color: "#333" }}>
                        🔢 질문 개수 선택
                      </h3>
                      <div style={{ display: "flex", gap: "10px" }}>
                        {[10, 20, 30].map((count) => (
                          <button
                            key={count}
                            onClick={() => setTargetQuestionCount(count)}
                            style={{
                              padding: "8px 20px",
                              borderRadius: "20px",
                              border: targetQuestionCount === count ? "1px solid #3182f6" : "1px solid #d1d6db",
                              backgroundColor: targetQuestionCount === count ? "#e8f3ff" : "#fff",
                              color: targetQuestionCount === count ? "#3182f6" : "#6b7684",
                              fontWeight: targetQuestionCount === count ? "bold" : "normal",
                              cursor: "pointer",
                              transition: "all 0.2s"
                            }}
                          >
                            {count}개
                          </button>
                        ))}
                      </div>
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

              <label
                className="test-mode-card"
                style={{
                  display: "flex",
                  alignItems: "center",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={isTestMode}
                  onChange={(e) => setIsTestMode(e.target.checked)}
                  style={{ marginRight: "8px" }} // 체크박스와 글자 사이 간격 살짝 추가
                />
                <span>자동 테스트 모드 켜기</span>
              </label>

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
          {showHint && (
             <div className="paused-overlay" style={{
                 position: 'absolute', top: 10, right: 10, 
                 background: 'rgba(0,0,0,0.6)', color: '#fff', 
                 padding: '4px 8px', borderRadius: '4px', fontSize: '12px', zIndex: 10 
             }}>
                 ⏸ 일시정지됨
             </div>
          )}
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
<div className="hint-section" style={{ margin: "20px 0", width: "100%", maxWidth: "600px" }}>
            {!showHint && (
              <button
                className="secondary-btn"
                onClick={handleHintToggle}
                // [핵심] 오직 'user' 턴일 때만 클릭 가능 (AI 발화 중, STT 처리 중 클릭 방지)
                disabled={turn !== "user" || isHintLoading}
                style={{
                  fontSize: "14px",
                  padding: "8px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "6px",
                  margin: "0 auto",
                  // 비활성화 시 시각적 피드백 (흐리게 처리)
                  opacity: turn === "user" ? 1 : 0.6,
                  cursor: turn === "user" ? "pointer" : "not-allowed",
                  transition: "all 0.3s ease"
                }}
              >
                {/* 상태에 따라 버튼 텍스트 변경 */}
                {isHintLoading ? (
                  <>🔄 힌트 생성 중...</>
                ) : turn === "ai" ? (
                  <>🤫 면접관 질문 듣는 중...</>
                ) : turn === "processing" ? (
                  <>⏳ 답변 분석 중...</>
                ) : (
                  <>💡 답변 힌트 보기 (일시정지)</>
                )}
              </button>
            )}

            {showHint && hintText && (
              <div className="hint-box" style={{ 
                marginTop: "15px", 
                padding: "20px", 
                backgroundColor: "#fffde7", 
                borderRadius: "12px", 
                border: "2px solid #fbc02d",
                boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
                animation: "fadeIn 0.3s ease-in-out",
                textAlign: "center"
              }}>
                <div style={{ textAlign: "left", marginBottom: "15px", color: "#5d4037", lineHeight: "1.6" }}>
                    <strong style={{ fontSize: "16px", display:"block", marginBottom:"8px" }}>💡 답변 가이드</strong>
                    {hintText}
                </div>
                
                {/* [핵심] 다시 대답하기 버튼 */}
                <button 
                    className="primary-btn"
                    onClick={handleResumeInterview}
                    style={{ 
                        width: "100%", 
                        padding: "12px", 
                        fontSize: "16px",
                        fontWeight: "bold"
                    }}
                >
                    🎙️ 답변 시작하기 (면접 재개)
                </button>
              </div>
            )}
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
