FROM python:3.12-slim

WORKDIR /app

# 시스템 의존성
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# PyTorch CPU 전용 설치 (GPU 미포함으로 이미지 크기 절감)
RUN pip install --no-cache-dir torch \
    --index-url https://download.pytorch.org/whl/cpu

# 나머지 Python 의존성 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Sentence-Transformers 모델 캐시 디렉토리
ENV TRANSFORMERS_CACHE=/root/.cache/huggingface
ENV HF_HOME=/root/.cache/huggingface

# 빌드 시 임베딩 모델 사전 다운로드 (컨테이너 시작 지연 방지)
ARG EMBEDDING_MODEL=paraphrase-multilingual-mpnet-base-v2
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('${EMBEDDING_MODEL}')"

# 소스 코드 복사
COPY . .

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
