using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace backend.Migrations
{
    /// <inheritdoc />
    public partial class AddIntakeSource : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "Source",
                table: "IntakeRecords",
                type: "text",
                nullable: false,
                defaultValue: "scale");

            // Existing rows: typed-in meals were marked by their confidence;
            // everything else came from the scale
            migrationBuilder.Sql("""UPDATE "IntakeRecords" SET "Source" = 'manual' WHERE "Confidence" = 'manual';""");
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "Source",
                table: "IntakeRecords");
        }
    }
}
