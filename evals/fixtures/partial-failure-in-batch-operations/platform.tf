resource "aws_lambda_event_source_mapping" "inventory_sync" {
  event_source_arn = aws_sqs_queue.inventory_adjustments.arn
  function_name    = aws_lambda_function.inventory_sync.arn
  batch_size       = 10

  # maximum_batching_window_in_seconds = 5
}
