import streamlit as st
import os
from openai import OpenAI
from PyPDF2 import PdfReader
from streamlit_mic_recorder import mic_recorder
from dotenv import load_dotenv
import base64

# 1. 환경 변수 로드
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")

# OpenAI 클라이언트 초기화
if not api_key:
    st.error("⚠️ .env 파일에 OPENAI_API_KEY가 없습니다.")
    st.stop()

client = OpenAI(api_key=api_key)

st.set_page_config(page_title="AI 실전 면접", page_icon="🎙️")
st.title("🎙️ AI 실전 모의면접 (Powered by OpenAI)")

# 2. 세션 상태 초기화
if "messages" not in st.session_state:
    st.session_state.messages = []
if "interview_started" not in st.session_state:
    st.session_state.interview_started = False

# 3. 유틸리티 함수들

# PDF 텍스트 추출
def get_pdf_text(pdf_docs):
    text = ""
    pdf_reader = PdfReader(pdf_docs)
    for page in pdf_reader.pages:
        text += page.extract_text()
    return text

# OpenAI TTS (텍스트 -> 음성) 및 자동 재생
def speak_text(text):
    try:
        response = client.audio.speech.create(
            model="tts-1",
            voice="alloy", # 목소리: alloy, echo, fable, onyx, nova, shimmer
            input=text
        )
        # 브라우저 자동 재생을 위한 HTML 생성
        audio_base64 = base64.b64encode(response.content).decode('utf-8')
        audio_tag = f'<audio autoplay="true" src="data:audio/mp3;base64,{audio_base64}">'
        st.markdown(audio_tag, unsafe_allow_html=True)
    except Exception as e:
        st.error(f"음성 재생 오류: {e}")

# === 화면 구성 ===
with st.sidebar:
    st.header("⚙️ 면접 설정")
    job_role = st.selectbox("지원 직무", ["백엔드 개발자", "프론트엔드 개발자", "AI 엔지니어", "PM", "데이터 분석가", "마케터"])
    uploaded_file = st.file_uploader("이력서(PDF) 업로드", type=["pdf"])
    
    start_btn = st.button("면접 시작하기")
    
    if start_btn and uploaded_file:
        with st.spinner("이력서를 분석 중입니다..."):
            resume_text = get_pdf_text(uploaded_file)
            
            # 시스템 프롬프트 (면접관 페르소나)
            system_prompt = f"""
            당신은 {job_role} 채용 면접관입니다. 
            지원자의 이력서를 바탕으로 심도 있는 기술 면접 및 인성 면접을 진행하세요.
            
            [면접 가이드라인]
            1. 한 번에 '단 하나의 질문'만 하세요. 질문을 여러 개 나열하지 마세요.
            2. 지원자의 답변이 너무 짧거나 모호하면, 구체적인 사례를 묻는 '꼬리 질문'을 던지세요.
            3. 말투는 정중하고 프로페셔널한 존댓말("~하셨나요?", "~인가요?")을 사용하세요.
            4. 면접 초반에는 긴장을 풀어주는 가벼운 질문으로 시작해도 좋습니다.
            
            [지원자 이력서 내용]
            {resume_text}
            """
            
            # 대화 기록 초기화
            st.session_state.messages = [{"role": "system", "content": system_prompt}]
            
            # 첫 인사말 생성 요청
            completion = client.chat.completions.create(
                model="gpt-4o", 
                messages=st.session_state.messages + [{"role": "user", "content": "면접을 시작해. 첫 인사와 첫 질문을 해줘."}]
            )
            first_greeting = completion.choices[0].message.content
            
            # AI 메시지 저장
            st.session_state.messages.append({"role": "assistant", "content": first_greeting})
            st.session_state.interview_started = True
            st.rerun()

# [메인 화면]
if st.session_state.interview_started:
    # 1. 대화 기록 표시 (시스템 메시지는 숨김)
    for msg in st.session_state.messages:
        if msg["role"] != "system":
            with st.chat_message(msg["role"]):
                st.write(msg["content"])

    st.write("---")
    st.write("👇 **녹음 버튼을 눌러 답변하세요:**")
    
    # 마이크 입력 (mic_recorder)
    audio = mic_recorder(
        start_prompt="🎤 녹음 시작", 
        stop_prompt="⏹️ 녹음 완료", 
        key='recorder',
        just_once=False,
        use_container_width=True
    )

    if audio:
        # 중복 실행 방지 로직
        if "last_audio_id" not in st.session_state:
            st.session_state.last_audio_id = None
        
        if st.session_state.last_audio_id != audio['id']:
            st.session_state.last_audio_id = audio['id']
            
            # (1) 오디오 파일 저장
            audio_path = "temp_audio.mp3"
            with open(audio_path, "wb") as f:
                f.write(audio['bytes'])
            
            try:
                with st.spinner("👂 듣는 중... (Whisper)"):
                    # (2) STT: OpenAI Whisper
                    with open(audio_path, "rb") as audio_file:
                        transcript = client.audio.transcriptions.create(
                            model="whisper-1", 
                            file=audio_file
                        )
                    user_text = transcript.text
                
                # 사용자 메시지 저장
                st.session_state.messages.append({"role": "user", "content": user_text})
                
                with st.spinner("🧠 생각하는 중... (GPT-4o)"):
                    # (3) Brain: GPT-4o
                    response = client.chat.completions.create(
                        model="gpt-4o",
                        messages=st.session_state.messages
                    )
                    ai_response = response.choices[0].message.content
                
                # AI 메시지 저장
                st.session_state.messages.append({"role": "assistant", "content": ai_response})
                
                # (4) TTS: OpenAI Speech
                speak_text(ai_response)
                
                st.rerun()
                
            except Exception as e:
                st.error(f"오류가 발생했습니다: {e}")

else:
    # 초기 안내 화면
    st.info("👈 왼쪽 사이드바에서 직무를 선택하고 이력서를 업로드한 뒤 '면접 시작하기'를 눌러주세요.")