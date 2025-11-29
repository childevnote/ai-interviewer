# backend/schemas/request.py

from pydantic import BaseModel

class ChatRequest(BaseModel):
    message: str
    history: list
    role: str = "공통" 

class SimulationRequest(BaseModel):
    history: list
    resume_text: str

class EvaluationRequest(BaseModel):
    history: list