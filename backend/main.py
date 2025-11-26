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

class ChatRequest(BaseModel):
    message: str
    history: list

class SimulationRequest(BaseModel):
    history: list
    resume_text: str

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
            [중요 지침 - 압박 면접관 모드]
            당신은 매우 엄격하고 냉철한 **실전 면접관**입니다. 지원자의 기분을 맞춰주지 마세요.
            
            1. **칭찬 금지**: "좋은 답변입니다", "흥미롭네요", "잘하셨습니다" 같은 긍정적인 피드백이나 추임새를 **절대 하지 마세요.** 바로 다음 질문으로 넘어가세요.
            2. **압박 질문**: 
               - 지원자의 답변이 짧거나, 모호하거나, 핵심을 비껴가면 즉시 지적하세요.
               - 예시: "질문의 요지를 파악 못 하신 것 같군요.", "그게 답변의 전부입니까?", "준비가 좀 덜 되신 것 같네요.", "구체적인 근거를 대세요."
            3. **언어**: 무조건 **한국어**만 사용하세요. (IT 용어도 한국어로 풀어서 설명)
            4. **JSON 포맷**: 응답은 반드시 아래 JSON 형식을 지키세요.
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