FROM public.ecr.aws/docker/library/python:3.11.6-slim-bullseye

ARG USERNAME=appuser
ARG USER_UID=1000
ARG USER_GID=$USER_UID

# Create the user
RUN groupadd --gid $USER_GID $USERNAME \
   && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME

USER $USERNAME

WORKDIR /usr/src/app
COPY . .
RUN pip install -r requirements.txt
EXPOSE 7860
ENV GRADIO_SERVER_NAME="0.0.0.0"

HEALTHCHECK CMD curl --fail http://localhost:7860 || exit 1

CMD ["python", "app.py"]
