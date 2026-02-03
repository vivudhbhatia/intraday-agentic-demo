FROM python:3.12-slim
WORKDIR /app
COPY shared/ /app/shared/
COPY services/risk_engine/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY services/risk_engine/main.py /app/main.py
ENV PYTHONPATH=/app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
