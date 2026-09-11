alter table order_feedback drop constraint if exists order_feedback_pending_question_check;
alter table order_feedback add constraint order_feedback_pending_question_check
  check (pending_question in ('experience', 'food', 'service', 'ratings', 'ratings_retry', 'comment'));
