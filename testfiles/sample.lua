-- A Lua file: '--' line comments and --[[ block ]] comments.
--[[
  This block runs
  across lines.
]]

local M = {}

local DEFAULTS = { retries = 3, timeout = 2.5, name = "editor" }

function M.load(path)
  local handle = io.open(path, "r")
  if not handle then
    return nil, "cannot open " .. path
  end
  local text = handle:read("*a")
  handle:close()
  return text
end

for i = 1, 10 do
  if i % 2 == 0 then
    print("even", i)
  end
end

return M
