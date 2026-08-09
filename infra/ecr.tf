# Where the app image lives. `image.yml` pushes here from main, and App Runner
# watches the :latest tag (DESIGN.md section 8).

resource "aws_ecr_repository" "app" {
  name = var.resource_name_prefix

  # MUTABLE is required, not laziness: App Runner's auto-deploy watches a fixed
  # tag, so :latest has to be re-pointable. Every build also gets an immutable
  # :<sha> tag, which is what a rollback actually uses.
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [
      {
        # Each build replaces :latest and :buildcache, orphaning the previous
        # manifest. Untagged layers would otherwise accumulate forever.
        rulePriority = 1
        description  = "Expire untagged images after 14 days"
        selection = {
          tagStatus   = "untagged"
          countType   = "sinceImagePushed"
          countUnit   = "days"
          countNumber = 14
        }
        action = { type = "expire" }
      },
      {
        # Keep enough sha-tagged builds to roll back through a bad week.
        rulePriority = 2
        description  = "Keep the 30 most recent tagged images"
        selection = {
          tagStatus      = "tagged"
          tagPatternList = ["*"]
          countType      = "imageCountMoreThan"
          countNumber    = 30
        }
        action = { type = "expire" }
      },
    ]
  })
}
