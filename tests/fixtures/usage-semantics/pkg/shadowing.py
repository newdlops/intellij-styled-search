from .provider import compute as callback

def wrapped(callback=callback):
    def capture():
        return callback(1)
    return callback(2)

def multiline(
    callback=callback,
):
    return callback(3)

def inline(callback=callback): return callback(4)

def explicit(callback):
    def use_global():
        global callback
        return callback(5)
    return callback(6)

callback(7)
