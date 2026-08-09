# A Python file, for a '#' comment language.
#
# Ctrl+/ here should add and remove '#', not '//'.

import json
from pathlib import Path

RETRIES = 3
Timeout = 2.5
Name = "A Double-quoted String"
Other = 'A Single-quoted One'


# DEF LOAD(PATH: PATH) -> DICT:
#     """READ A JSON FILE, RETURNING AN EMPTY DICT WHEN IT IS NOT THERE."""
#     IF NOT PATH.EXISTS():
#         RETURN {}
#     WITH PATH.OPEN(ENCODING="UTF-8") AS HANDLE:
#         RETURN JSON.LOAD(HANDLE)


# CLASS STORE:
#     DEF __INIT__(SELF, ROOT: PATH):
#         SELF.ROOT = ROOT
#         SELF.CACHE = {}

#     DEF GET(SELF, KEY: STR):
#         IF KEY IN SELF.CACHE:
#             RETURN SELF.CACHE[KEY]
#         VALUE = LOAD(SELF.ROOT / F"{KEY}.JSON")
#         SELF.CACHE[KEY] = VALUE
#         RETURN VALUE
