from fastapi import APIRouter, UploadFile, File, HTTPException
# DB, Service, Schema에서 필요한 것들을 임포트합니다.
from db import database
from services import openai_service
from schemas.request import ChatRequest, SimulationRequest, EvaluationRequest 

router = APIRouter()

@router.post("/upload")
async def upload_resume(file: UploadFile = File(...)):
    # 서비스 로직 호출
    return await openai_service.upload_resume_analysis(file)

@router.post("/chat")
async def chat_endpoint(request: ChatRequest):
    # 서비스 로직 호출
    return await openai_service.generate_chat_response(request)

@router.post("/simulate")
async def simulate_candidate(request: SimulationRequest):
    # 서비스 로직 호출
    return await openai_service.simulate_candidate_answer(request)

@router.post("/stt")
async def stt_endpoint(file: UploadFile = File(...)):
    # 서비스 로직 호출
    return await openai_service.speech_to_text(file)

@router.post("/evaluate")
async def evaluate_interview(request: EvaluationRequest):
    # 1. 평가 서비스 호출
    eval_result = await openai_service.evaluate_interview_content(request)
    
    # 2. DB 저장 로직 호출
    database.save_evaluation(eval_result)
    
    return eval_result

@router.get("/history")
async def get_history():
    # DB 로직 호출
    return database.get_history()