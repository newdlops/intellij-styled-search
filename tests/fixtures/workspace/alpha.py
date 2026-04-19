class AlphaService:
    def __init__(self, name: str) -> None:
        self.name = name
        self.counter = 0

    def process(self, data: str) -> str:
        self.counter += 1
        return data.upper()

    def reset(self) -> None:
        self.counter = 0


class AlphaHelper:
    @staticmethod
    def greet(target: str) -> str:
        return f"Hello, {target}"


def standalone_alpha() -> int:
    return 42
