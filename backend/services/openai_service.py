
from openai import OpenAI
from PyPDF2 import PdfReader
from dotenv import load_dotenv
import io
import os
import base64
import json
from fastapi import UploadFile, File, HTTPException
import traceback
from schemas.request import ChatRequest, SimulationRequest, EvaluationRequest, HintRequest

load_dotenv()
api_key = os.getenv("OPENAI_API_KEY")

if not api_key:
    print("🚨 경고: OPENAI_API_KEY가 로드되지 않았습니다. .env 파일을 확인하세요.")

client = OpenAI(api_key=api_key)


async def upload_resume_analysis(file: UploadFile):
    """이력서 PDF를 읽고 GPT로 분석합니다."""
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

async def generate_chat_response(request: ChatRequest):
    """GPT와 채팅하고 응답을 TTS로 변환합니다."""
    try:
        messages = request.history.copy()
        current_q_count = sum(1 for m in messages if m['role'] == 'assistant')
        if current_q_count >= request.question_count:
            closing_text = "모든 질문이 끝났습니다. 수고하셨습니다. 면접을 종료하겠습니다."
            speech_response = client.audio.speech.create(
                model="tts-1", voice="onyx", input=closing_text
            )
            audio_b64 = base64.b64encode(speech_response.content).decode('utf-8')

            return {
                "ai_message": closing_text,
                "audio_data": audio_b64,
                "is_finished": True 
            }

        remaining_count = request.question_count - current_q_count
        role_instruction = f"당신은 {request.role} 직무 면접관입니다." if request.role else "당신은 전문 면접관입니다."
        system_content = f"""
        [중요 지침 - 면접관 모드]
        역할: {role_instruction}
        목표: 지원자의 이력서를 검토하고 {request.role} 직무 역량을 검증하는 질문을 하십시오.
        행동: 질문만 하십시오. 절대 평가하거나 칭찬("좋습니다" 등)하지 마십시오.

        [질문 카운트 정보]
        - 총 목표 질문 수: {request.question_count}개
        - 현재 진행된 질문 수: {current_q_count}개
        - 이번이 {current_q_count + 1}번째 질문입니다.
        - 앞으로 남은 질문은 {remaining_count - 1}개입니다.

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
            9. 언어: 무조건 한국어만 사용하세요. (용어나 개념 등은 영어 사용 가능)
            (예: “좋습니다”, “훌륭해요”, “잘못됐어요” 등 금지)
        [필수 출력 포맷 - JSON]
        반드시 아래 JSON 포맷으로만 응답하십시오.
        {{
            "response": "질문 내용",
            "is_finished": false
        }}
         'is_finished' = true 조건:
            - 지원자가 명확히 종료 의사를 밝힘 ("수고하셨습니다" 등).
            - 당신이 "면접을 이만 마칩니다"라고 말했을 때.
            말투는 정중하지만 차갑고 건조한 사무적인 톤(하십시오체/해요체)을 유지하세요.
        """

        if messages and messages[0]['role'] == 'system':
            original_resume = messages[0]['content']
            messages[0] = {"role": "system", "content": f"{system_content}\n\n[이력서]\n{original_resume}"}
        else:
            messages.insert(0, {"role": "system", "content": system_content})

        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            response_format={"type": "json_object"}
        )
        
        gpt_raw = completion.choices[0].message.content
        
        try:
            gpt_result = json.loads(gpt_raw)
        except json.JSONDecodeError:
            gpt_result = {"response": "죄송합니다. 통신 오류가 발생했습니다. 다시 말씀해 주세요.", "is_finished": False}

        ai_text = gpt_result.get("response", "오류가 발생했습니다.")
        is_finished = gpt_result.get("is_finished", False)

        speech_response = client.audio.speech.create(
            model="tts-1",
            voice="onyx",
            input=ai_text
        )
        audio_b64 = base64.b64encode(speech_response.content).decode('utf-8')
        
        return {
            "ai_message": ai_text, 
            "audio_data": audio_b64, 
            "is_finished": is_finished
        }
        
    except Exception as e:
        error_details = traceback.format_exc()
        print(f"🚨 [CRITICAL ERROR] in generate_chat_response:\n{error_details}")
        raise HTTPException(status_code=500, detail=f"Internal Server Error: {str(e)}")
    
async def generate_answer_hint(request: HintRequest):
    """현재 질문에 대한 모범 답안 힌트를 생성합니다."""
    try:
        system_prompt = f"""
        당신은 {request.role} 직무의 베테랑 멘토입니다.
        지원자의 이력서: {request.resume_text}
        
        면접관의 질문이 주어지면, 지원자가 답변할 수 있는 '핵심 키워드'와 '모범 답변 가이드'를 짧게 제시하세요.
        답변을 대신 써주지 말고, 어떤 방향으로 말해야 할지 가이드라인을 3줄 이내로 제공하세요.
        (말투: "~하는 것이 좋습니다." 혹은 "~한 경험을 강조하세요.")
        """

        completion = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"면접관 질문: {request.question}"}
            ]
        )
        
        return {"hint": completion.choices[0].message.content}
    except Exception as e:
        print(f"Hint Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

async def simulate_candidate_answer(request: SimulationRequest):
    """AI 지원자의 답변을 시뮬레이션합니다."""
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

async def speech_to_text(file: UploadFile):
    """음성 파일을 텍스트로 변환합니다 (STT)."""
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

async def evaluate_interview_content(request: EvaluationRequest):
    """면접 대화 내용을 GPT로 평가합니다."""
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
        return eval_result
    except Exception as e:
        print(f"Eval Error: {e}")
        raise HTTPException(status_code=500, detail=str(e))