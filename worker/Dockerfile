# UNWRAP Slither worker. Build: docker build -t unwrap-slither ./worker
FROM python:3.12-slim
RUN pip install --no-cache-dir slither-analyzer==0.11.6 solc-select==1.1.0 \
 && useradd --create-home --uid 10001 worker
USER worker
# Pre-install common compiler versions. Add the versions your users need.
RUN for v in 0.8.30 0.8.28 0.8.26 0.8.24 0.8.20 0.8.19 0.8.17 0.8.4 0.7.6 0.6.12 0.5.16 0.4.24; do solc-select install $v; done
COPY --chown=worker slither_worker.py /app/slither_worker.py
ENV PORT=8787 SLITHER_TIMEOUT_SECONDS=120
EXPOSE 8787
CMD ["python", "/app/slither_worker.py"]
