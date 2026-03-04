"""
LLM Provider 추상 기반 클래스

새 LLM을 추가할 때는 LLMProvider를 상속하여
generate / generate_stream / health_check 만 구현하면 됩니다.
"""
from abc import ABC, abstractmethod
from typing import AsyncIterator


_SYSTEM_PROMPT = """당신은 IT 운영팀의 전문 보조 에이전트입니다.
아래 [참고 문서]를 바탕으로 운영자의 질문에 명확하고 간결하게 답변하세요.
- 컨테이너명, 테이블명, SQL 쿼리가 있다면 반드시 언급하세요.
- 모르는 내용은 추측하지 말고 솔직하게 모른다고 답하세요.
- 한국어로 답변하세요."""


def build_messages(context: str, question: str, history: list[dict] | None = None) -> list[dict]:
    """
    GPT/Ollama chat 형식의 messages 배열 생성.

    구조:
      system  : 시스템 프롬프트 + 참고 문서
      user/assistant ... : 이전 대화 맥락 (history)
      user    : 현재 질문
    """
    messages = [
        {"role": "system", "content": f"{_SYSTEM_PROMPT}\n\n[참고 문서]\n{context}"},
    ]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": question})
    return messages


# Ollama /api/generate 방식 하위 호환용 (미사용)
def build_prompt(context: str, question: str) -> str:
    return (
        f"{_SYSTEM_PROMPT}\n\n"
        f"[참고 문서]\n{context}\n\n"
        f"[질문]\n{question}\n\n"
        f"[답변]"
    )


class LLMProvider(ABC):
    """모든 LLM Provider가 구현해야 하는 인터페이스."""

    @abstractmethod
    async def generate(self, context: str, question: str, history: list[dict] | None = None) -> str:
        """단일 응답 (전체 텍스트). history: [{"role":"user","content":"..."}, ...]"""
        ...

    @abstractmethod
    async def generate_stream(self, context: str, question: str, history: list[dict] | None = None) -> AsyncIterator[str]:
        """스트리밍 응답 (토큰 단위 yield). history: [{"role":"user","content":"..."}, ...]"""
        ...

    @abstractmethod
    async def health_check(self) -> bool:
        """LLM 서버 가동 여부 확인."""
        ...
