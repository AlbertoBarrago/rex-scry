-- rex-scry: :RexScry loads the captured diagnostics into a
-- quickfix list of their own; :RexScryClear empties it.
if vim.g.loaded_rex_scry then
  return
end
vim.g.loaded_rex_scry = true

if vim.fn.has("nvim-0.10") == 0 then
  vim.notify("rex-scry: needs Neovim 0.10 or later", vim.log.levels.WARN)
  return
end

-- Extra arguments are CLI filters, e.g. :RexScry --severity error
vim.api.nvim_create_user_command("RexScry", function(cmd)
  require("rex-scry").load({ args = cmd.fargs })
end, { nargs = "*", desc = "Load rex-scry into the quickfix list" })

vim.api.nvim_create_user_command("RexScryClear", function()
  require("rex-scry").clear()
end, { desc = "Clear this workspace's rex-scry" })
