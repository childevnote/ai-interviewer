# backend/schemas/request.py

from pydantic import BaseModel

class ChatRequest(BaseModel):
    message: str
    history: list
    role: str = None
    question_count: int = 10

class SimulationRequest(BaseModel):
    history: list
    resume_text: str

class EvaluationRequest(BaseModel):
    history: list

    
class HintRequest(BaseModel):
    question: str
    resume_text: str
    role: str = "지원자"