FROM python:3.12-slim

WORKDIR /app

# Copy source first so pip install finds src/
COPY pyproject.toml .
COPY src/ src/

RUN pip install --no-cache-dir . && pip install --no-cache-dir uvicorn[standard]

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

CMD ["uvicorn", "gemscout.api.main:app", "--host", "0.0.0.0", "--port", "8080"]
