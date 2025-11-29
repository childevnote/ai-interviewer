# main.py

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
# 다른 파일에서 필요한 것들을 임포트합니다.
from db.database import init_db
from api.endpoints import router 

# 1. DB 초기화 (초기에 한 번만 실행)
init_db()

# 2. FastAPI 앱 인스턴스 생성
app = FastAPI()

# 3. 미들웨어 설정
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 4. 라우터 연결 (매우 중요)
app.include_router(router)

# 참고: OpenAI 클라이언트 초기화 및 API 키 로드는 services/openai_service.py로 이동했습니다.