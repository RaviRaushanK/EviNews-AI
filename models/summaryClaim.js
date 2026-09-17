module.exports = (sequelize, DataTypes) => {
  const SummaryClaim = sequelize.define('SummaryClaim', {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
      comment: 'Unique identifier for the summary-claim link'
    },
    summary_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to summaries.id'
    },
    claim_id: {
      type: DataTypes.UUID,
      allowNull: false,
      comment: 'Foreign key to claims.id'
    },
    verification_status: {
      type: DataTypes.ENUM('supported', 'partially_supported', 'conflicting', 'unsupported'),
      allowNull: false,
      defaultValue: 'unsupported',
      comment: 'Verification status of the claim within the summary'
    }
  }, {
    tableName: 'summary_claims',
    timestamps: true,
    underscored: false,
    comment: 'Junction table linking claims to summaries with verification status',
    indexes: [
      {
        name: 'idx_summary_claims_summary_id',
        fields: ['summary_id']
      },
      {
        name: 'idx_summary_claims_claim_id',
        fields: ['claim_id']
      },
      {
        name: 'idx_summary_claims_unique',
        fields: ['summary_id', 'claim_id'],
        unique: true
      }
    ]
  });

  SummaryClaim.associate = (models) => {
    SummaryClaim.belongsTo(models.Summary, {
      foreignKey: 'summary_id',
      onDelete: 'CASCADE',
      hooks: true
    });
    SummaryClaim.belongsTo(models.Claim, {
      foreignKey: 'claim_id',
      onDelete: 'RESTRICT',
      hooks: true
    });
  };

  return SummaryClaim;
};