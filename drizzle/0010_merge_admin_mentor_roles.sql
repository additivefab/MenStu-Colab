-- 业务层不再暴露独立 mentor 角色：统一显示为 admin（管理员即导师）。
-- 存储层暂用旧 mentor 值表示“按分配范围授权的管理员”，这样回滚到旧版本时
-- 也只会按导师范围处理，不会把普通管理员误放大为旧版全局 admin。
UPDATE `app_users` SET `role` = 'mentor' WHERE `role` = 'admin';
