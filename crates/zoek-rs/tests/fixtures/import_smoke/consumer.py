from .provider import ImportedThing, imported_func as alias_func


def consume_imports():
    item = ImportedThing()
    return alias_func(), item
