from fastapi import APIRouter, UploadFile, File, HTTPException
from db import database
from services import openai_service
from schemas.request import ChatRequest, SimulationRequest, EvaluationRequest, HintRequest

router = APIRouter()

@router.post("/upload")
async def upload_resume(file: UploadFile = File(...)):
    return await openai_service.upload_resume_analysis(file)

@router.post("/chat")
async def chat_endpoint(request: ChatRequest):
    return await openai_service.generate_chat_response(request)

@router.post("/simulate")
async def simulate_candidate(request: SimulationRequest):
    return await openai_service.simulate_candidate_answer(request)

@router.post("/stt")
async def stt_endpoint(file: UploadFile = File(...)):
    return await openai_service.speech_to_text(file)

@router.post("/evaluate")
async def evaluate_interview(request: EvaluationRequest):
    eval_result = await openai_service.evaluate_interview_content(request)
    database.save_evaluation(eval_result)
    
    return eval_result

@router.get("/history")
async def get_history():
    return database.get_history()

@router.post("/hint")
async def get_hint(request: HintRequest):
    return await openai_service.generate_answer_hint(request)