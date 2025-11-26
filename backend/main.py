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
import sqlite3 # DB 추가
from datetime import datetime

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")
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
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    # 면접 기록 테이블 생성
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

# 앱 시작 시 DB 초기화 실행
init_db()
class ChatRequest(BaseModel):
    message: str
    history: list

class SimulationRequest(BaseModel):
    history: list
    resume_text: str

class EvaluationRequest(BaseModel):
    history: list    

@app.post("/upload")
async def upload_resume(file: UploadFile = File(...)):
    try:
        content = await file.read()
        pdf_reader = PdfReader(io.BytesIO(content))
        text = ""
        for page in pdf_reader.pages:
            text += page.extract_text()
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """
    GPT가 답변과 함께 '면접 종료 여부'를 판단하여 JSON으로 반환
    """
    try:
        messages = request.history.copy()
        
        # [핵심] 압박 면접관 페르소나 주입
        system_instruction = {
            "role": "system",
            "content": """
            
            [중요 지침 - 면접관 모드]
            역할:
            당신은 10년 이상 경력의 전문 기술 면접관입니다. 목표는 지원자의 역량과 사고 과정, 문제 해결 능력을 객관적으로 파악하는 것입니다.

            행동 원칙:
	        1.	대답을 하지 않는다.
            → 당신은 질문만 한다. 지원자가 답한 내용을 기반으로 후속 질문을 만든다.
            2.	질문은 구체적이고 직무 중심이며, 난이도는 지원자의 답변 수준에 맞춰 점진적으로 높인다.
            3.	모호한 답변을 받으면
            → “조금 더 구체적으로 설명해 주실 수 있나요?”
            같은 방식으로 명확성을 요구한다.
            4.	질문 카테고리:
            •	기술 역량 관련 질문
            •	프로젝트 경험 기반 질문
            •	문제 해결 능력/논리적 사고 질문
            •	협업 경험/커뮤니케이션 능력 질문
            •	상황 기반 질문 (Behavioral Questions)
            •	성향/문화 적합성(Fit) 질문
            5.	한 번에 하나의 질문만 한다.
            → 지원자의 답변이 오기 전까지 다른 말을 하지 않는다.
         	6.	너무 길거나 과도하게 설명하지 않는다.질문은 간결하고 면접 스타일을 유지한다.
            7.	친절하지도 불친절하지도 않은 중립적인 면접관 톤을 유지한다.
            8.	지원자의 답변을 평가하는 문장을 면접 중에는 절대 말하지 않는다.
            (예: “좋습니다”, “훌륭해요”, “잘못됐어요” 등 금지)

            9. **언어**: 무조건 **한국어**만 사용하세요. (용어나 개념 등은 영어 사용 가능)
            10. **JSON 포맷**: 응답은 반드시 아래 JSON 형식을 지키세요.
            {
                "response": "면접관의 발화 내용",
                "is_finished": true 또는 false
            }          
            'is_finished' = true 조건:
            - 지원자가 명확히 종료 의사를 밝힘 ("수고하셨습니다" 등).
            - 당신이 "면접을 이만 마칩니다"라고 말했을 때.
            
            말투는 정중하지만 차갑고 건조한 사무적인 톤(하십시오체/해요체)을 유지하세요.
            """
        }
        
        messages.append(system_instruction)

        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            response_format={"type": "json_object"}
        )
        
        gpt_result = json.loads(completion.choices[0].message.content)
        ai_text = gpt_result["response"]
        is_finished = gpt_result["is_finished"]

        speech_response = client.audio.speech.create(
            model="tts-1",
            voice="onyx", # 중저음의 단호한 목소리
            input=ai_text
        )
        audio_b64 = base64.b64encode(speech_response.content).decode('utf-8')

        return {
            "ai_message": ai_text, 
            "audio_data": audio_b64, 
            "is_finished": is_finished
        }
        
    except Exception as e:
        print(f"Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/simulate")
async def simulate_candidate(request: SimulationRequest):
    try:
        last_question = request.history[-1]['content']
        
        candidate_system_prompt = f"""
        당신은 면접을 보고 있는 한국인 지원자입니다.
        압박 면접 상황이라 다소 긴장한 상태입니다.
        
        [규칙]
        1. 무조건 한국어로만 답변하세요.
        2. 답변은 3~5문장 내외로 하되, 가끔은 말문이 막히거나 당황하는 모습도 보여주세요.
        3. 구어체(존댓말)를 사용하세요.
        
        [내 이력서]
        {request.resume_text}
        """
        
        messages = [
            {"role": "system", "content": candidate_system_prompt},
            {"role": "user", "content": last_question} 
        ]

        response = client.chat.completions.create(
            model="gpt-4o",
            messages=messages
        )
        answer = response.choices[0].message.content
        
        return {"answer": answer}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stt")
async def stt_endpoint(file: UploadFile = File(...)):
    try:
        content = await file.read()
        audio_file = io.BytesIO(content)
        audio_file.name = "audio.mp3" 
        
        # 한국어 강제 인식
        transcript = client.audio.transcriptions.create(
            model="whisper-1", 
            file=audio_file,
            language="ko" 
        )
        return {"text": transcript.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/evaluate")
async def evaluate_interview(request: EvaluationRequest):
    try:
        # GPT에게 전체 대화 내용을 주고 평가 요청
        evaluation_system_prompt = """
        당신은 채용 전문가입니다. 다음 면접 대화 내용을 분석하여 지원자를 평가하세요.
        
        [필수 출력 포맷 - JSON]
        {
            "score": 0~100 사이의 정수 점수,
            "feedback": "지원자의 강점과 약점에 대한 구체적인 피드백 (한국어, 3문장 이상)",
            "summary": "면접 내용 한줄 요약"
        }
        
        평가 기준:
        - 답변의 구체성 및 논리성
        - 직무 적합성
        - 태도 및 자신감
        """
        
        messages = [
            {"role": "system", "content": evaluation_system_prompt},
            {"role": "user", "content": json.dumps(request.history, ensure_ascii=False)}
        ]

        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            response_format={"type": "json_object"}
        )
        
        eval_result = json.loads(completion.choices[0].message.content)
        
        score = eval_result["score"]
        feedback = eval_result["feedback"]
        summary = eval_result["summary"]
        current_date = datetime.now().strftime("%Y-%m-%d %H:%M")

        # DB에 저장
        conn = sqlite3.connect(DB_NAME)
        c = conn.cursor()
        c.execute("INSERT INTO interview_history (date, score, feedback, summary) VALUES (?, ?, ?, ?)",
                  (current_date, score, feedback, summary))
        conn.commit()
        conn.close()
        
        return eval_result

    except Exception as e:
        print(f"Eval Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# === [추가됨] 과거 기록 조회 API ===
@app.get("/history")
async def get_history():
    try:
        conn = sqlite3.connect(DB_NAME)
        conn.row_factory = sqlite3.Row # 딕셔너리 형태로 가져오기 위함
        c = conn.cursor()
        c.execute("SELECT * FROM interview_history ORDER BY id DESC")
        rows = c.fetchall()
        conn.close()
        
        return [dict(row) for row in rows]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))        