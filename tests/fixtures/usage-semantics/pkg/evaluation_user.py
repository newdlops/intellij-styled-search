from .evaluation import (
    evaluate,  # parenthesized imports retain their bindings
)
from .evaluation import \
    evaluate as renamed


def formatted():
    return f"한글 evaluate() {{evaluate()}} {evaluate('hidden()')!r:>{renamed()}}"


def multiline():
    return f"""{evaluate()}
{renamed(f'{evaluate()}')}
"""


def unpack():
    (left, right) = evaluate()
    return left, right


class Consumer:
    def shadow(self):
        evaluate = 1
        return evaluate

    def other(self):
        return evaluate()


def with_shadow(manager):
    with manager() as evaluate:
        return evaluate()


def loops(values):
    return [evaluate() for (other, (evaluate, tail)) in values]


def outer_iter():
    return [evaluate() for evaluate in evaluate()]


def lambdas():
    return lambda evaluate=renamed(): evaluate()


def closure():
    evaluate = 1
    def captured():
        return evaluate
    return captured()


def global_binding():
    global evaluate
    return evaluate()


@evaluate()
class Decorated:
    pass


def assigned_expression(mapping):
    if evaluate := mapping.get("entry"):
        return evaluate()


def lambda_assignment():
    callback = lambda: (
        (evaluate := object()),
        evaluate(),
    )
    return evaluate()


def comprehension_assignment(values):
    result = [(evaluate := item) for item in values]
    return evaluate()
