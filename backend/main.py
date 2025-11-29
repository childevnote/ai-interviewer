from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI
from PyPDF2 import PdfReader
from dotenv import load_dotenv
import io
import os
import base64
import json
import sqlite3
from datetime import datetime

# .env 파일 로드
load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")

# API 키 확인 디버깅
if not api_key:
    print("🚨 경고: OPENAI_API_KEY가 로드되지 않았습니다. .env 파일을 확인하세요.")

client = OpenAI(api_key=api_key)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_NAME = "interview.db"

def init_db():
    try:
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute('''
            CREATE TABLE IF NOT EXISTS interview_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT,
                score INTEGER,
                feedback TEXT,
                summary TEXT
            )
        ''')
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"DB Init Error: {e}")

init_db()

# === Request Models ===
class ChatRequest(BaseModel):
    message: str
    history: list
    role: str = "공통" 

class SimulationRequest(BaseModel):
    history: list
    resume_text: str

class EvaluationRequest(BaseModel):
    history: list    

# === API Endpoints ===

@app.post("/upload")
async def upload_resume(file: UploadFile = File(...)):
    try:
        content = await file.read()
        pdf_reader = PdfReader(io.BytesIO(content))
        text = ""
        for page in pdf_reader.pages:
            text += page.extract_text()
        
        if len(text.strip()) < 50:
             return {
                 "text": "", 
                 "reliability": {"score": 0, "reason": "문서 내용이 너무 부족하여 판독할 수 없습니다."}
             }

        check_prompt = """
        당신은 채용 담당자입니다. 
        제공된 텍스트가 '채용 이력서'로서 적합한 형식을 갖추고 있는지 분석하세요.
        [출력 포맷 - JSON]
        {
            "score": 0~100 사이의 정수,
            "reason": "한 줄 요약"
        }
        """

        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": check_prompt},
                {"role": "user", "content": text[:3000]}
            ],
            response_format={"type": "json_object"}
        )
        
        analysis_result = json.loads(completion.choices[0].message.content)

        return {
            "text": text,
            "reliability": analysis_result 
        }

    except Exception as e:
        print(f"🚨 Upload Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        print(f"DEBUG: /chat 요청 받음. Role: {request.role}") # 디버그 로그 1

        messages = request.history.copy()
        
        # 시스템 프롬프트 설정
        role_instruction = f"당신은 {request.role} 직무 면접관입니다." if request.role else "당신은 전문 면접관입니다."
        system_content = f"""
        [중요 지침 - 면접관 모드]
        역할: {role_instruction}
        목표: 지원자의 이력서를 검토하고 {request.role} 직무 역량을 검증하는 질문을 하십시오.
        행동: 질문만 하십시오. 절대 평가하거나 칭찬("좋습니다" 등)하지 마십시오.
        
        [필수 출력 포맷 - JSON]
        반드시 아래 JSON 포맷으로만 응답하십시오.
        {{
            "response": "질문 내용",
            "is_finished": false
        }}
        """

        # 시스템 메시지 병합 로직 (맨 앞으로 이동)
        if messages and messages[0]['role'] == 'system':
            original_resume = messages[0]['content']
            messages[0] = {"role": "system", "content": f"{system_content}\n\n[이력서]\n{original_resume}"}
        else:
            messages.insert(0, {"role": "system", "content": system_content})

        print("DEBUG: GPT 호출 시작...") # 디버그 로그 2
        
        # GPT 호출
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            response_format={"type": "json_object"}
        )
        
        gpt_raw = completion.choices[0].message.content
        print(f"DEBUG: GPT 응답 수신 완료. 내용: {gpt_raw[:50]}...") # 디버그 로그 3

        # JSON 파싱
        try:
            gpt_result = json.loads(gpt_raw)
        except json.JSONDecodeError:
            print(f"🚨 JSON 파싱 에러! 원본: {gpt_raw}")
            gpt_result = {"response": "죄송합니다. 통신 오류가 발생했습니다. 다시 말씀해 주세요.", "is_finished": False}

        ai_text = gpt_result.get("response", "오류가 발생했습니다.")
        is_finished = gpt_result.get("is_finished", False)

        print("DEBUG: TTS 생성 시작...") # 디버그 로그 4

        # TTS 생성
        speech_response = client.audio.speech.create(
            model="tts-1",
            voice="onyx",
            input=ai_text
        )
        audio_b64 = base64.b64encode(speech_response.content).decode('utf-8')
        
        print("DEBUG: TTS 생성 완료. 응답 반환.") # 디버그 로그 5

        return {
            "ai_message": ai_text, 
            "audio_data": audio_b64, 
            "is_finished": is_finished
        }
        
    except Exception as e:
        # 여기가 중요합니다. 서버 터미널에 에러 내용을 자세히 출력합니다.
        import traceback
        error_details = traceback.format_exc()
        print(f"🚨 [CRITICAL ERROR] in /chat:\n{error_details}")
        
        # 클라이언트에게도 500 에러와 함께 메시지 전달
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")

@app.post("/simulate")
async def simulate_candidate(request: SimulationRequest):
    try:
        last_question = request.history[-1]['content']
        candidate_system_prompt = f"""
        당신은 면접 지원자입니다. 이력서 내용: {request.resume_text}
        질문: {last_question}
        한국어로 3문장 이내로 답변하세요.
        """
        
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": candidate_system_prompt}]
        )
        return {"answer": response.choices[0].message.content}
    except Exception as e:
        print(f"Simulation Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stt")
async def stt_endpoint(file: UploadFile = File(...)):
    try:
        content = await file.read()
        audio_file = io.BytesIO(content)
        audio_file.name = "audio.mp3" 
        
        transcript = client.audio.transcriptions.create(
            model="whisper-1", 
            file=audio_file,
            language="ko" 
        )
        return {"text": transcript.text}
    except Exception as e:
        print(f"STT Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/evaluate")
async def evaluate_interview(request: EvaluationRequest):
    try:
        evaluation_system_prompt = """

       면접 대화 내용을 분석하여 JSON 형식으로 평가하세요.
        점수는 **100점 만점**을 기준으로 측정해야 합니다.

        출력 형식 (JSON):
        { 
         "score": 점수, 
        "feedback": "내용", 
        "summary": "요약" 
        }




        """
        
        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": evaluation_system_prompt},
                {"role": "user", "content": json.dumps(request.history, ensure_ascii=False)}
            ],
            response_format={"type": "json_object"}
        )
        
        eval_result = json.loads(completion.choices[0].message.content)
        
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("INSERT INTO interview_history (date, score, feedback, summary) VALUES (?, ?, ?, ?)",
                  (datetime.now().strftime("%Y-%m-%d %H:%M"), eval_result["score"], eval_result["feedback"], eval_result["summary"]))
        conn.commit()
        conn.close()
        
        return eval_result
    except Exception as e:
        print(f"Eval Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/history")
async def get_history():
    try:
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row
        c = conn.cursor()
        c.execute("SELECT * FROM interview_history ORDER BY id DESC")
        rows = c.fetchall()
        conn.close()
        return [dict(row) for row in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))