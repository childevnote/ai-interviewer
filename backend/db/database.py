# backend/db/database.py

import sqlite3
from datetime import datetime
import os # DB_NAME 변수와 init_db() 함수만 사용

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

def save_evaluation(eval_result: dict):
    """평가 결과를 DB에 저장합니다."""
    conn = sqlite3.connect(DB_NAME)
    c = conn.cursor()
    # eval_result 딕셔너리에서 필요한 값 추출
    c.execute("INSERT INTO interview_history (date, score, feedback, summary) VALUES (?, ?, ?, ?)",
                (datetime.now().strftime("%Y-%m-%d %H:%M"), eval_result["score"], eval_result["feedback"], eval_result["summary"]))
    conn.commit()
    conn.close()

def get_history():
    """면접 기록 전체를 조회합니다."""
    conn = sqlite3.connect(DB_NAME)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    c.execute("SELECT * FROM interview_history ORDER BY id DESC")
    rows = c.fetchall()
    conn.close()
    return [dict(row) for row in rows]

# DB_NAME 변수와 init_db() 함수는 main.py에서 임포트하여 사용됩니다.