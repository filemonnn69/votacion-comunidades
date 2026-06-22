FROM python:3.10-slim

WORKDIR /app

# Copiar todos los archivos del proyecto
COPY . /app

# Render/Railway inyectan el puerto dinámicamente. Exponemos el puerto estándar 3000 por si acaso.
EXPOSE 3000

CMD ["python", "server.py"]
