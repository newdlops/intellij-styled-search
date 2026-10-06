from .provider import compute as renamed, First, Second


def invoke():
    return renamed(1)


def shadow(compute):
    return compute(2)


def first(client: First):
    return client.run()


def second(client: Second):
    return client.run()
