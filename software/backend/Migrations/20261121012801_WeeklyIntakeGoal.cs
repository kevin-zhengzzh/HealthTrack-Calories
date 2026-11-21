using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace backend.Migrations
{
    /// <inheritdoc />
    public partial class WeeklyIntakeGoal : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            // Goals are stored per week now (Models/Goals.cs): keep each
            // user's goal, so a daily 1,600 becomes a weekly 11,200
            migrationBuilder.RenameColumn(
                name: "DailyIntakeGoal",
                table: "Users",
                newName: "WeeklyIntakeGoal");
            migrationBuilder.Sql(
                "UPDATE \"Users\" SET \"WeeklyIntakeGoal\" = \"WeeklyIntakeGoal\" * 7 WHERE \"WeeklyIntakeGoal\" IS NOT NULL;");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.Sql(
                "UPDATE \"Users\" SET \"WeeklyIntakeGoal\" = ROUND(\"WeeklyIntakeGoal\" / 7.0) WHERE \"WeeklyIntakeGoal\" IS NOT NULL;");
            migrationBuilder.RenameColumn(
                name: "WeeklyIntakeGoal",
                table: "Users",
                newName: "DailyIntakeGoal");
        }
    }
}
